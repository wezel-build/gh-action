import * as core from "@actions/core";
import * as github from "@actions/github";

export interface ExperimentResult {
  experiment: string;
  action:
    | "none"
    | "baseline_created"
    | "baseline_updated"
    | "regression_detected"
    | "bisect_step"
    | "culprit_found";
  details?: {
    summary_name?: string;
    good?: string;
    bad?: string;
    culprit?: string;
    culprit_message?: string;
    culprit_author?: string;
    baseline_value?: number;
    regressed_value?: number;
    regression_pct?: number;
  };
}

export interface StandaloneReport {
  results: ExperimentResult[];
}

export function parseReport(stdout: string): StandaloneReport {
  // The CLI may print log lines before the JSON. Find the JSON object.
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("No JSON found in wezel output");
  }
  const json = stdout.slice(jsonStart);
  return JSON.parse(json) as StandaloneReport;
}

export function needsRedispatch(report: StandaloneReport): boolean {
  return report.results.some(
    (r) =>
      r.action === "regression_detected" || r.action === "bisect_step"
  );
}

export function getCulprits(report: StandaloneReport): ExperimentResult[] {
  return report.results.filter((r) => r.action === "culprit_found");
}

export async function dispatchWorkflow(token: string): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  // Get the current workflow ID from the run.
  const workflowRef = process.env.GITHUB_WORKFLOW_REF;
  const workflowFile = workflowRef
    ? workflowRef.split("/").pop()?.split("@")[0]
    : undefined;

  if (!workflowFile) {
    core.warning(
      "Could not determine workflow file for re-dispatch. " +
      "Bisection will continue on the next scheduled run."
    );
    return;
  }

  core.info(`Dispatching workflow ${workflowFile} for bisection continuation`);

  await octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: workflowFile,
    ref: github.context.ref,
  });
}

export async function openIssue(
  token: string,
  result: ExperimentResult
): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const d = result.details!;

  const title = `Build regression: ${result.experiment}/${d.summary_name} +${d.regression_pct?.toFixed(1)}%`;

  const body = [
    `## Build regression detected`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Experiment** | \`${result.experiment}\` |`,
    `| **Summary** | \`${d.summary_name}\` |`,
    `| **Regression** | +${d.regression_pct?.toFixed(1)}% (${d.baseline_value} → ${d.regressed_value}) |`,
    `| **Culprit** | [\`${d.culprit?.slice(0, 7)}\`](/${owner}/${repo}/commit/${d.culprit}) — ${d.culprit_message} |`,
    `| **Author** | ${d.culprit_author} |`,
    ``,
    `Detected by [Wezel](https://github.com/wezel-build/wezel).`,
  ].join("\n");

  // Check if an issue with the same title already exists.
  const { data: existing } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    labels: "wezel",
  });

  if (existing.some((issue) => issue.title === title)) {
    core.info(`Issue already exists: ${title}`);
    return;
  }

  // Ensure the "wezel" label exists.
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: "wezel" });
  } catch {
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: "wezel",
      color: "f59e0b",
      description: "Build regression detected by Wezel",
    });
  }

  const { data: issue } = await octokit.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels: ["wezel"],
  });

  core.info(`Opened issue #${issue.number}: ${title}`);
}
