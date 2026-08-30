# js-linter-tools

The reproducible local benchmark runner behind the [warefeats.com "ESLint vs Biome" comparison](https://warefeats.com/benchmarks/eslint-vs-biome-javascript-lint/).

It copies ESLint's own `lib/` directory into a temp folder, then runs both ESLint and Biome against the same corpus with equivalent rule sets, collecting per-pass timing and summary statistics. Results live in this repo as `benchmark.json` (editorial metadata) plus one file per run under `runs/`.

## Requirements

- [Bun](https://bun.sh/) 1.4+

## Setup

```sh
bun install
```

## Usage

Full benchmark (3 warmup passes, 20 measured passes):

```sh
bun run benchmark
```

Quick smoke test (1 warmup, 3 passes):

```sh
bun run smoke
```

Write results to a file instead of stdout:

```sh
bun run benchmark -- --output=results/run.json
```

### Flags

- `--quick` — shorthand for `--runs=3 --warmups=1`
- `--runs=N` — number of measured passes (default: 20)
- `--warmups=N` — number of warmup passes (default: 3)
- `--output=PATH` — write JSON to a file instead of stdout

## Publishing results

Convert a completed benchmark result into a run file and update `benchmark.json`:

```sh
bun run benchmark -- --output=results/run.json
just publish results/run.json
```

The publish step maps the runner's raw output into the site's `BenchmarkRun` shape, writes `runs/<date>-<rig>.json`, and appends it to `benchmark.json.runs` (idempotent — re-publishing the same run replaces it).

Optional flags: `--machine="MacBook Pro"` (display name for the machine; defaults to the chip label) and `--label="M2 Max (local)"` (toggle text shown on the page; defaults to chip name + "(local)").

### Updating the site

1. Merge the new run file and `benchmark.json` update here.
2. In [warefeats/warefeats.com](https://github.com/warefeats/warefeats.com): bump this slug's `ref` in `web/data/registry.json` to the merge commit SHA, run `bun run sync`, commit registry + cache together, PR, merge.

## Type checking and tests

```sh
bun run check   # tsc
bun run test     # bun test
```

## Repository

[github.com/warefeats/js-linter-tools](https://github.com/warefeats/js-linter-tools)
