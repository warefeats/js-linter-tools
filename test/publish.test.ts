import { describe, expect, test } from "bun:test";
import { convertToRun, rigSlug, updateBenchmarkRuns } from "../src/publish";
import type { RunnerResult } from "../src/publish";

const MOCK_RESULT: RunnerResult = {
  schemaVersion: 1,
  benchmark: "eslint-vs-biome-javascript-lint",
  generatedAt: "2026-08-25T14:30:00.000Z",
  corpus: { source: "eslint/lib/**/*.js", files: 391, lines: 99880, bytes: 2732670 },
  environment: {
    cpu: "Apple M2 Max",
    logicalCores: 12,
    architecture: "arm64",
    platform: "darwin",
    release: "25.6.0",
    totalMemoryBytes: 103079215104,
    freeMemoryBytesAtStart: 50000000000,
    bun: "1.4.0",
  },
  protocol: { warmups: 3, runs: 20, processModel: "fresh process per pass" },
  candidates: [
    {
      id: "eslint",
      name: "ESLint",
      version: "9.34.0",
      command: "eslint --no-config-lookup ...",
      exitCodes: [1],
      statistics: { medianMs: 105.6, meanMs: 106, minMs: 103.5, maxMs: 108.9 },
      samplesMs: [105.6, 106.2],
    },
    {
      id: "biome",
      name: "Biome",
      version: "2.2.2",
      command: "biome lint ...",
      exitCodes: [0],
      statistics: { medianMs: 75.2, meanMs: 75.4, minMs: 71.5, maxMs: 79.6 },
      samplesMs: [75.2, 75.6],
    },
  ],
  speedup: 1.4,
};

const BENCHMARK_RUN_KEYS = ["schemaVersion", "id", "label", "publishedAt", "environment", "protocol", "candidates"];
const ENVIRONMENT_KEYS = ["machine", "chip", "cores", "memory", "os", "arch", "runtime"];
const PROTOCOL_KEYS = ["warmups", "runs", "processModel", "cacheState", "output"];
const STATISTICS_KEYS = ["medianMs", "meanMs", "minMs", "maxMs"];

describe("rig slug", () => {
  test("strips Apple prefix and collapses", () => {
    expect(rigSlug("Apple M2 Max")).toBe("m2max");
  });

  test("handles non-Apple chips", () => {
    expect(rigSlug("AMD Ryzen 9 7950X")).toBe("amdryzen97950x");
  });
});

describe("publish conversion", () => {
  const run = convertToRun(MOCK_RESULT, { machine: "MacBook Pro", publishedAt: "2026-08-26" });

  test("produces exactly the BenchmarkRun keys", () => {
    expect(Object.keys(run).sort()).toEqual(BENCHMARK_RUN_KEYS.sort());
  });

  test("environment has exactly seven keys", () => {
    expect(Object.keys(run.environment).sort()).toEqual(ENVIRONMENT_KEYS.sort());
  });

  test("protocol has exactly five keys", () => {
    expect(Object.keys(run.protocol).sort()).toEqual(PROTOCOL_KEYS.sort());
  });

  test("statistics has exactly four keys", () => {
    for (const c of run.candidates) {
      expect(Object.keys(c.statistics).sort()).toEqual(STATISTICS_KEYS.sort());
    }
  });

  test("derives id from run date and rig slug", () => {
    expect(run.id).toBe("2026-08-25-m2max");
  });

  test("derives label from chip name", () => {
    expect(run.label).toBe("M2 Max (local)");
  });

  test("accepts a label override", () => {
    const custom = convertToRun(MOCK_RESULT, { machine: "MacBook Pro", label: "Studio (cloud)" });
    expect(custom.label).toBe("Studio (cloud)");
  });

  test("maps environment fields", () => {
    expect(run.environment.machine).toBe("MacBook Pro");
    expect(run.environment.chip).toBe("Apple M2 Max");
    expect(run.environment.cores).toBe("12 CPU cores");
    expect(run.environment.memory).toBe("96 GB");
    expect(run.environment.os).toMatch(/^macOS /);
    expect(run.environment.arch).toBe("arm64");
    expect(run.environment.runtime).toBe("Bun 1.4.0");
  });

  test("enriches protocol with cache and output descriptions", () => {
    expect(run.protocol.processModel).toBe("A new CLI process for every measured pass");
    expect(run.protocol.cacheState).toBe("Warm filesystem cache after 3 unmeasured passes");
    expect(run.protocol.output).toBe("Diagnostics produced and redirected away from the terminal");
  });

  test("strips runner-only candidate fields", () => {
    for (const c of run.candidates) {
      expect(c).not.toHaveProperty("command");
      expect(c).not.toHaveProperty("exitCodes");
    }
  });

  test("adds branding to known candidates", () => {
    const eslint = run.candidates.find((c) => c.id === "eslint");
    expect(eslint?.logo).toBe("/logos/eslint.svg");
    expect(eslint?.color).toBe("#4B32C3");
    expect(eslint?.homepage).toBe("https://eslint.org");
  });

  test("defaults machine to chip label when not provided", () => {
    const noMachine = convertToRun(MOCK_RESULT, {});
    expect(noMachine.environment.machine).toBe("M2 Max");
  });
});

describe("benchmark.json update", () => {
  test("appends a new run path", () => {
    const benchmark = { runs: ["runs/existing.json"] };
    updateBenchmarkRuns(benchmark, "runs/new.json");
    expect(benchmark.runs).toEqual(["runs/existing.json", "runs/new.json"]);
  });

  test("does not duplicate an existing path", () => {
    const benchmark = { runs: ["runs/a.json", "runs/b.json"] };
    updateBenchmarkRuns(benchmark, "runs/b.json");
    expect(benchmark.runs).toEqual(["runs/a.json", "runs/b.json"]);
  });

  test("is idempotent across multiple calls", () => {
    const benchmark = { runs: ["runs/a.json"] };
    updateBenchmarkRuns(benchmark, "runs/b.json");
    updateBenchmarkRuns(benchmark, "runs/b.json");
    updateBenchmarkRuns(benchmark, "runs/b.json");
    expect(benchmark.runs).toEqual(["runs/a.json", "runs/b.json"]);
  });
});
