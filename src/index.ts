import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { installWezel } from "./install";
import { dispatchSelf } from "./dispatch";

/** Mirrors `wezel experiment next --output-format json`. */
interface NextResult {
  claimed: boolean;
  run_id?: number;
  experiment?: string;
  commit?: string;
  status?: "complete" | "failed";
  error?: string;
  queue_pending?: boolean;
}

async function run(): Promise<void> {
  const command = core.getInput("command") || "run";
  const apiUrl = core.getInput("api-url");
  const projectDir = core.getInput("project-dir");
  const wezelVersion = core.getInput("wezel-version");
  const githubToken = core.getInput("github-token");

  // The API token claims from the queue, so it's required for `run` but
  // irrelevant to `lint` (which only reads committed config).
  const token = core.getInput("token", { required: command === "run" });

  await core.group("Install wezel", () =>
    installWezel(wezelVersion, githubToken)
  );

  // Env for every wezel invocation. WEZEL_API_TOKEN is project-scoped, so the
  // server picks the queue from it — no upstream is sent.
  const env: Record<string, string> = {
    ...process.env,
    WEZEL_API_URL: apiUrl,
    WEZEL_API_TOKEN: token,
    // wezel's fetcher (tool sync, forager downloads) authenticates GitHub
    // requests with this — without it those calls are anonymous and hit the
    // 60-req/hr rate limit on shared CI runner IPs.
    GH_TOKEN: githubToken,
    RUST_LOG: process.env.RUST_LOG ?? "info",
  } as Record<string, string>;

  switch (command) {
    case "lint":
      await lint(projectDir, env);
      return;
    case "run":
      await drainQueue(projectDir, githubToken, env);
      return;
    default:
      core.setFailed(`unknown command "${command}" — expected "run" or "lint"`);
  }
}

/**
 * `command: lint` — validate the committed experiment config (input schemas,
 * patch applicability, summaries) on a PR before merge.
 *
 * Deliberately does NOT run `project tool sync`: lint fetches each forager's
 * schema sidecar read-only from the committed `wezel.lock`, so it never
 * re-locks. Sync would re-pin to the latest tags and then regenerate
 * `schema.json` against those newer foragers — but `wezel.lock` is allowed to
 * lag, so a sync-and-diff gate would wrongly force lock freshness. Lint's own
 * `schema.json` staleness check already validates the bundle against the
 * locked foragers. The patch-applicability check needs the repo checked out at
 * the PR head, which `actions/checkout` provides by default.
 */
async function lint(
  projectDir: string,
  env: Record<string, string>
): Promise<void> {
  const code = await core.group("Lint experiments", () =>
    exec.exec("wezel", ["experiment", "lint", "--project-dir", projectDir], {
      env,
      ignoreReturnCode: true,
    })
  );
  if (code !== 0) {
    core.setFailed(`wezel experiment lint found problems (exit code ${code})`);
  }
}

/** `command: run` — claim and run the next queued experiment, then optionally
 *  re-dispatch to keep draining. */
async function drainQueue(
  projectDir: string,
  githubToken: string,
  env: Record<string, string>
): Promise<void> {
  const selfDispatch = core.getBooleanInput("self-dispatch");

  await core.group("Sync foragers", async () => {
    await exec.exec(
      "wezel",
      ["project", "tool", "sync", "--project-dir", projectDir],
      { env }
    );
  });

  let stdout = "";
  const code = await core.group("Claim and run next experiment", () =>
    exec.exec(
      "wezel",
      [
        "experiment",
        "next",
        "--project-dir",
        projectDir,
        "--output-format",
        "json",
      ],
      {
        env,
        ignoreReturnCode: true,
        listeners: { stdout: (data) => (stdout += data.toString()) },
      }
    )
  );

  // A nonzero exit is an infrastructure failure (bad config/token, server
  // unreachable) — measurement failures exit 0 with status "failed".
  if (code !== 0) {
    core.setFailed(`wezel experiment next exited with code ${code}`);
    return;
  }

  const result = parseResult(stdout);
  core.setOutput("claimed", String(result.claimed));
  core.setOutput("status", result.status ?? "");
  core.setOutput("run-id", result.run_id != null ? String(result.run_id) : "");

  if (!result.claimed) {
    core.info("Queue empty — nothing to do.");
    return;
  }

  const where = `run ${result.run_id} (${result.experiment} @ ${result.commit?.slice(0, 7)})`;
  if (result.status === "failed") {
    core.warning(`${where} failed: ${result.error ?? "unknown error"}`);
  } else {
    core.info(`Processed ${where}: complete`);
  }

  // A run was processed, so more work likely remains — a bisection just
  // enqueued its next midpoint, or other runs are queued. Re-dispatch to keep
  // draining. (Keyed on `claimed`, not `queue_pending`, which burrow still
  // stubs to false; the only cost is one final empty run per drain.)
  if (selfDispatch) {
    await core.group("Re-dispatch for next run", () =>
      dispatchSelf(githubToken)
    );
  }
}

function parseResult(stdout: string): NextResult {
  // Take the last non-empty line so any stray output can't break parsing.
  const line = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) {
    throw new Error("no JSON output from `wezel experiment next`");
  }
  return JSON.parse(line) as NextResult;
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
