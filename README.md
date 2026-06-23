# Wezel GitHub Action

Runs [Wezel](https://github.com/wezel-build/wezel) build-regression experiments
from a workflow. Each invocation claims one queued run for your project from the
Wezel API, measures the claimed commit, and reports the results back. Regression
detection and bisection happen server-side; bisection midpoints are re-enqueued
and drained by subsequent runs.

## Usage

```yaml
name: Wezel
on:
  schedule:
    - cron: "0 * * * *"   # hourly safety net
  workflow_dispatch:       # required for self-dispatch (see below)

permissions:
  contents: read
  actions: write           # required for self-dispatch

concurrency:
  group: wezel
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: wezel-build/gh-action@v1
        with:
          token: ${{ secrets.WEZEL_TOKEN }}
```

### Linting experiments on pull requests

Set `command: lint` to validate the committed `.wezel/` config on a PR —
forager input schemas, summary definitions, and that each step's `.patch`
applies cleanly — without touching the run queue. The job fails if lint finds
problems. No API token is needed.

```yaml
name: Wezel lint
on:
  pull_request:
    paths:
      - ".wezel/**"

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4   # patch applicability is checked against HEAD
      - uses: wezel-build/gh-action@v1
        with:
          command: lint
```

Patch applicability is checked against the committed `HEAD`, so an
`actions/checkout` step is required. `lint` does not run `wezel project tool
sync`, so it never re-locks: a deliberately-stale `wezel.lock` is fine as long
as every forager used by an experiment is pinned in it.

## Inputs

| Input | Default | Description |
|---|---|---|
| `command` | `run` | `run` claims and runs the next queued experiment; `lint` validates committed config (incl. patch applicability) without touching the queue. |
| `token` | — | Project-scoped Wezel API token (`wez_live_…`). Required for `run`; unused by `lint`. Store it as a secret. |
| `api-url` | `https://api.wezel.build` | Wezel API base URL. |
| `project-dir` | `.` | Directory containing the project's `.wezel/` config. |
| `wezel-version` | `latest` | wezel version to install, or `latest` for the newest stable release. |
| `self-dispatch` | `true` | After a run, re-dispatch the workflow to claim the next one. See below. |
| `github-token` | `${{ github.token }}` | Used to download wezel releases and re-dispatch the workflow. |

## Outputs

| Output | Description |
|---|---|
| `claimed` | `"true"`/`"false"` — whether a run was processed this invocation. |
| `status` | `complete` or `failed` (empty when nothing was claimed). |
| `run-id` | The claimed run id (empty when nothing was claimed). |

## Self-dispatch

A single invocation processes one run. With `self-dispatch: true` (the default),
the action re-dispatches its own workflow whenever it processed a run, so the
queue — including bisection midpoints enqueued mid-drain — is drained promptly
instead of one run per scheduled tick. It stops when a claim comes back empty.

This requires the workflow to:

- have a `workflow_dispatch` trigger, and
- grant `permissions: actions: write`.

If either is missing the action logs a warning and falls back to draining on the
next scheduled run. Set `self-dispatch: false` to opt out and rely solely on the
schedule.
