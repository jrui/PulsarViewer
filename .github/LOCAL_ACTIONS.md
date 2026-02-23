# Running GitHub Actions locally

You can catch workflow failures before pushing by running them locally with [**act**](https://github.com/nektos/act).

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- [act](https://github.com/nektos/act#installation) installed (e.g. `brew install act` on macOS)

## Run the Linux (Ubuntu) build

The build workflow only runs on **tag** pushes (`v*`) or **workflow_dispatch**. Run the Ubuntu job (the one that fails on missing deps) with:

```bash
# Simulate a tag push and run only the ubuntu-latest matrix job (from repo root)
act push -j build-tauri --matrix os:ubuntu-latest --ref refs/tags/v1.0.0
```

Or trigger via `workflow_dispatch` with a tag input:

```bash
act workflow_dispatch -j build-tauri --matrix os:ubuntu-latest -e <(echo '{"inputs":{"tag":"v1.0.0"}}')
```

## Limitations

- **act runs jobs in Linux containers.** Only the `ubuntu-latest` matrix job runs; macOS and Windows jobs are skipped or unsupported.
- **Upload artifacts step** will fail locally (no real GitHub release). That’s expected; the important part is that the build steps succeed.
- To fully validate macOS/Windows, push a tag or use workflow_dispatch on GitHub.

## Quick check before pushing

```bash
act push -j build-tauri --matrix os:ubuntu-latest --ref refs/tags/v1.0.0 --dry-run   # list what would run
act push -j build-tauri --matrix os:ubuntu-latest --ref refs/tags/v1.0.0              # run Linux build
```
