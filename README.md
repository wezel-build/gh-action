# Wezel GitHub Action

Runs one exact experiment assigned by Fiflok. The workflow checks out the
assigned commit, then passes Fiflok's `run-id` and `experiment-name` dispatch
inputs to this action. The action never claims arbitrary queue work and never
dispatches another workflow.

## Usage

```yaml
name: Wezel assigned run
on:
  workflow_dispatch:
    inputs:
      run_id:
        description: Fiflok run ID
        required: true
      experiment_name:
        description: Experiment to run
        required: true
      commit_sha:
        description: Assigned commit
        required: true
      project_dir:
        description: Directory containing the Wezel project
        required: true

permissions:
  contents: read

jobs:
  run:
    runs-on: ubuntu-latest
    concurrency:
      group: wezel-run-${{ inputs.run_id }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.commit_sha }}
      - uses: wezel-build/gh-action@v1
        with:
          token: ${{ secrets.WEZEL_RUNNER_TOKEN }}
          run-id: ${{ inputs.run_id }}
          experiment-name: ${{ inputs.experiment_name }}
          project-dir: ${{ inputs.project_dir }}
```

The action marks the assigned run `running`, executes:

```text
wezel experiment run EXPERIMENT --run-id ID --save yes --output-format json
```

It uploads a zstd-compressed tar containing only `report.json` and the optional
`attachments/` tree, then marks the run `complete`. Any setup, execution,
packaging, upload, or completion error is reported as `failed` when possible.

The runner image must provide `tar` and `zstd` (both are available on GitHub's
Ubuntu-hosted runners).

### Linting experiments on pull requests

`command: lint` preserves the existing local-only validation mode. It checks
forager schemas, summaries, and patch applicability without using a token or
touching a run.

```yaml
name: Wezel lint
on:
  pull_request:
    paths: [".wezel/**"]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: wezel-build/gh-action@v1
        with:
          command: lint
```

Lint does not run `wezel project tool sync`, so it does not update
`wezel.lock`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `command` | `run` | `run` executes an assigned run; `lint` validates committed config. |
| `token` | — | Fiflok runner-scoped token. Required for `run`; unused by `lint`. |
| `run-id` | — | Exact Fiflok run ID. Required for `run`. |
| `experiment-name` | — | Exact assigned experiment. Required for `run`. |
| `api-url` | `https://api.wezel.build` | Fiflok API base URL. |
| `project-dir` | `.` | Directory containing `.wezel/`. |
| `wezel-version` | `latest` | Wezel version to install. |
| `github-token` | `${{ github.token }}` | Used only to download Wezel releases. |

## Outputs

| Output | Description |
|---|---|
| `status` | `complete` or `failed`. |
| `run-id` | Assigned run ID. |

## Run backlinks

The action supplies `WEZEL_RUN_BACKLINK` and `WEZEL_RUN_BACKLINK_LABEL` for the
current Actions run. Set either environment variable explicitly to override
the generated backlink.
