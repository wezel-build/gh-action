import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { installWezel } from "./install";
import { executeExactRun, updateStatus } from "./exact-run";

async function run(): Promise<void> {
  const command = core.getInput("command") || "run";
  const apiUrl = core.getInput("api-url");
  const projectDir = core.getInput("project-dir");
  const wezelVersion = core.getInput("wezel-version");
  const githubToken = core.getInput("github-token");

  // The runner token reports an assigned run; lint only reads committed config.
  const token = core.getInput("token", { required: command === "run" });

  // Environment for every Wezel invocation. The runner-scoped token is
  // also used below to report the exact assigned run through Fiflok's API.
  const env: Record<string, string> = {
    ...process.env,
    WEZEL_API_URL: apiUrl,
    WEZEL_API_TOKEN: token,
    // Where this run is executing, recorded against the claimed run so its logs
    // stay reachable from Wezel. wezel itself knows nothing about Actions, so
    // deriving the job URL is our job — and a caller who already set these keeps
    // their value.
    ...backlinkEnv(),
    // wezel's fetcher (tool sync, forager downloads) authenticates GitHub
    // requests with this — without it those calls are anonymous and hit the
    // 60-req/hr rate limit on shared CI runner IPs.
    GH_TOKEN: githubToken,
    RUST_LOG: process.env.RUST_LOG ?? "info",
  } as Record<string, string>;

  switch (command) {
    case "lint":
      await core.group("Install wezel", () =>
        installWezel(wezelVersion, githubToken)
      );
      await lint(projectDir, env);
      return;
    case "run":
      await runAssigned(
        projectDir,
        apiUrl,
        token,
        wezelVersion,
        githubToken,
        env
      );
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

/** Execute only the run explicitly assigned through workflow_dispatch inputs. */
async function runAssigned(
  projectDir: string,
  apiUrl: string,
  token: string,
  wezelVersion: string,
  githubToken: string,
  env: Record<string, string>
): Promise<void> {
  const rawRunId = core.getInput("run-id", { required: true });
  const experimentName = core.getInput("experiment-name", { required: true });
  if (!/^\d+$/.test(rawRunId) || !Number.isSafeInteger(Number(rawRunId))) {
    throw new Error(`invalid run-id "${rawRunId}" — expected a non-negative integer`);
  }
  const runId = Number(rawRunId);
  core.setOutput("run-id", rawRunId);
  try {
    await core.group("Install wezel", () =>
      installWezel(wezelVersion, githubToken)
    );
    await executeExactRun({ runId, experimentName, projectDir, apiUrl, token, env });
    core.setOutput("status", "complete");
    core.info(`Completed assigned run ${runId} (${experimentName}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setOutput("status", "failed");
    try {
      await updateStatus(apiUrl, token, runId, "failed", message);
    } catch (reportError) {
      core.warning(`Could not report run ${runId} failure: ${reportError instanceof Error ? reportError.message : String(reportError)}`);
    }
    throw error;
  }
}

/**
 * `WEZEL_RUN_BACKLINK*` pointing at the job this action is running in, which
 * wezel records against the run it claims. Empty when the caller already set a
 * backlink, or when the `GITHUB_*` variables that identify the job are missing.
 */
function backlinkEnv(): Record<string, string> {
  const {
    WEZEL_RUN_BACKLINK,
    WEZEL_RUN_BACKLINK_LABEL,
    GITHUB_SERVER_URL,
    GITHUB_REPOSITORY,
    GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT,
  } = process.env;

  if (WEZEL_RUN_BACKLINK) return {};
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return {};

  // The attempt segment goes on only for a re-run: without it the URL resolves
  // to the latest attempt, which by then may be measuring a different commit.
  const attempt =
    GITHUB_RUN_ATTEMPT && GITHUB_RUN_ATTEMPT !== "1"
      ? `/attempts/${GITHUB_RUN_ATTEMPT}`
      : "";
  const server = GITHUB_SERVER_URL.replace(/\/+$/, "");

  const env: Record<string, string> = {
    WEZEL_RUN_BACKLINK: `${server}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${attempt}`,
  };
  if (!WEZEL_RUN_BACKLINK_LABEL) {
    env.WEZEL_RUN_BACKLINK_LABEL = "GitHub Actions";
  }
  return env;
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
