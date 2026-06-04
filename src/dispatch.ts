import * as core from "@actions/core";
import * as github from "@actions/github";

/**
 * Re-dispatch the currently-running workflow so it claims the next queued run.
 *
 * Relies on `workflow_dispatch` being exempt from the rule that blocks
 * `GITHUB_TOKEN`-triggered events from spawning new runs, so the default token
 * chains the workflow as long as it has `permissions: actions: write`. Failures
 * are downgraded to warnings — the queue still drains on the next scheduled run.
 */
export async function dispatchSelf(token: string): Promise<void> {
  // GITHUB_WORKFLOW_REF looks like "owner/repo/.github/workflows/ci.yml@refs/heads/main".
  const workflowRef = process.env.GITHUB_WORKFLOW_REF;
  const workflowFile = workflowRef
    ? workflowRef.split("/").pop()?.split("@")[0]
    : undefined;

  if (!workflowFile) {
    core.warning(
      "Could not determine the workflow file for self-dispatch; the queue will drain on the next scheduled run."
    );
    return;
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowFile,
      ref: github.context.ref,
    });
    core.info(`Re-dispatched ${workflowFile} to process the next run.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(
      `Self-dispatch failed (${message}). Ensure the workflow has a \`workflow_dispatch\` trigger and \`permissions: actions: write\`. The queue will drain on the next scheduled run.`
    );
  }
}
