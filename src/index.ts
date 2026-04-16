import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { installWezel } from "./install";
import {
  parseReport,
  needsRedispatch,
  getCulprits,
  dispatchWorkflow,
  openIssue,
} from "./report";

async function run(): Promise<void> {
  const branch = core.getInput("branch");
  const threshold = core.getInput("threshold");
  const wezelVersion = core.getInput("wezel-version");
  const token = core.getInput("github-token");

  // 1. Install wezel.
  await core.group("Install wezel", () => installWezel(wezelVersion));

  // 2. Run standalone mode.
  let stdout = "";
  let stderr = "";

  const exitCode = await core.group("Run experiments", () =>
    exec.exec(
      "wezel",
      [
        "experiment",
        "daemon",
        "standalone",
        "--repo-dir",
        ".",
        "--branch",
        branch,
        "--threshold",
        threshold,
      ],
      {
        listeners: {
          stdout: (data) => {
            stdout += data.toString();
          },
          stderr: (data) => {
            stderr += data.toString();
          },
        },
        ignoreReturnCode: true,
        env: {
          ...process.env,
          RUST_LOG: "info",
        },
      }
    )
  );

  if (exitCode !== 0) {
    core.error(`wezel exited with code ${exitCode}`);
    if (stderr) {
      core.error(stderr);
    }
    core.setFailed("wezel experiment daemon standalone failed");
    return;
  }

  // 3. Parse report.
  const report = parseReport(stdout);
  core.info(`Report: ${report.results.length} experiment(s) processed`);

  for (const result of report.results) {
    core.info(`  ${result.experiment}: ${result.action}`);
  }

  // 4. Open issues for culprits.
  const culprits = getCulprits(report);
  for (const culprit of culprits) {
    await openIssue(token, culprit);
  }

  // 5. Re-dispatch if bisection is in progress.
  if (needsRedispatch(report)) {
    core.info("Bisection in progress — dispatching next step");
    await dispatchWorkflow(token);
  }

  // 6. Set outputs.
  core.setOutput("report", JSON.stringify(report));
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
