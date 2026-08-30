# js-linter-tools

The reproducible local benchmark runner behind the [warefeats.com "ESLint vs Biome" comparison](https://warefeats.com/benchmarks/eslint-vs-biome-javascript-lint/).

It copies ESLint's own `lib/` directory into a temp folder, then runs both ESLint and Biome against the same corpus with equivalent rule sets, collecting per-pass timing and summary statistics. The JSON output is what gets imported into the site catalog at [warefeats/warefeats.com](https://github.com/warefeats/warefeats.com).

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

## Type checking and tests

```sh
bun run check   # tsc
bun run test     # bun test
```

## Repository

[github.com/warefeats/js-linter-tools](https://github.com/warefeats/js-linter-tools)
