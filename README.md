# js-linter-tools

The reproducible local benchmark runner behind the [warefeats.com "ESLint vs Biome" comparison](https://warefeats.com/posts/2026-08-26-js-linter-tools-eslint-vs-biome/).

It copies ESLint 9.34.0's `lib/` directory into a temp folder, then runs both ESLint and Biome against the same corpus with equivalent rule sets, collecting per-pass timing and summary statistics. Results live in this repo as `benchmark.json` (editorial metadata) plus one file per run under `runs/`.

## Corpus

ESLint 9.34.0's `lib/`: 391 JavaScript files, 99,880 lines, 2,732,670 bytes. The runner takes it from the `eslint-9.34.0.tgz` npm tarball, downloaded once into `corpus/cache/` (gitignored) and checked against `corpus/checksums.txt` before every run, so the corpus stays the same whatever ESLint a run measures. It refuses to run unless the extracted files match the counts in `benchmark.json`.

## How a pass runs

Each linter starts inside the corpus folder and gets the files as relative paths. That matters for ESLint: with `--no-config-lookup` it takes its base path from the folder it starts in, and reports every file outside it as ignored, exiting 0 with nothing linted. The run published on 2026-08-26 started both linters from this repository's root with absolute paths into the temp folder, so its ESLint figure is ESLint starting up and ignoring all 391 files; Biome linted them. Before measuring, the runner now makes one unmeasured pass of each and refuses to go on unless ESLint's JSON report covers every file with none ignored and Biome says it checked every file.

Each measured pass runs both linters, in an order that alternates from pass to pass. ESLint runs as `node` on its CLI script and Biome as `node` on its launcher, which starts Biome's native binary: what the published run's `node_modules/.bin` links started on macOS. Each CLI's `--version` is recorded beside the installed version.

## Requirements

- [Bun](https://bun.sh/) 1.4+
- Node, which ESLint and Biome's launcher run on; `.node-version` pins the one fleet runs use
- Internet access on first run (to download the corpus tarball; cached afterward)

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

- `--quick` — shorthand for `--runs=3 --warmups=1`, and marks the results as a smoke run
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

## Fleet runs

`bun run src/publish.ts <results.json> --fleet --commit=<sha> --rig=<slug>` imports a run the warefeats fleet measured on its Windows rig, on the Node `.node-version` pins and with the tarball staged from the rig's cache. It refuses a smoke run, a CLI that reported another version than the installed one, and results without the every-file check; records the commit, the rig and each candidate's integrity hash from `bun.lock`; and writes `runs/<date>-<rig>.json` without touching `benchmark.json`. The fleet's PR then lists the run in `fleetRuns`, and fleet runs appear on the site's matchup, never on the post. `sectionSamples: "repeats"` says each sample is one fresh-process lint of the whole corpus, so the fleet's verdict check reads a new leader inside twice the standard error of the difference as a tie.

## Type checking and tests

```sh
bun run check   # tsc
bun run test     # bun test
```

## Repository

[github.com/warefeats/js-linter-tools](https://github.com/warefeats/js-linter-tools)
