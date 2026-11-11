import { describe, expect, test } from "bun:test";
import { checkFleetRun, convertToRun, fleetRun, lineupOf, rigSlug, updateBenchmarkRuns } from "../src/publish";
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

describe("fleet runs", () => {
  const RIG = { machine: "BOSGAME P6 Neo", chip: "AMD Ryzen 7 6800H with Radeon Graphics", cores: "8 cores / 16 threads", memory: "24 GB at 4800 MT/s", os: "Microsoft Windows 11 Pro 26H2 (build 26300)", arch: "x64" };
  const FLEET_RESULT: RunnerResult = {
    ...MOCK_RESULT,
    generatedAt: "2026-11-12T03:10:00.000Z",
    smoke: false,
    linted: { eslintProblems: { eslint: 23 }, biomeChecked: 391 },
    environment: { ...MOCK_RESULT.environment, node: "24.22.2" },
    rig: RIG,
    candidates: MOCK_RESULT.candidates.map((c) => ({ ...c, reportedVersion: c.version })),
  };
  // bun.lock's lines for the two candidates, trimmed, with the CRLF a Windows checkout can give it.
  const LOCK = [
    '    "@biomejs/biome": ["@biomejs/biome@2.2.2", "", { "optionalDependencies": { "@biomejs/cli-win32-x64": "2.2.2" }, "bin": { "biome": "bin/biome" } }, "sha512-biomehash=="],',
    '    "@biomejs/cli-win32-x64": ["@biomejs/cli-win32-x64@2.2.2", "", { "os": "win32", "cpu": "x64" }, "sha512-binaryhash=="],',
    '    "eslint": ["eslint@9.34.0", "", { "dependencies": { "@eslint/js": "9.34.0" }, "peerDependencies": { "jiti": "*" } }, "sha512-eslinthash=="],',
  ].join("\r\n");
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";

  test("is dated by the run, labelled with the rig and names the Node it ran on", () => {
    const run = fleetRun(FLEET_RESULT, { commit: COMMIT, rig: "radeon-680m-win11", machine: "BOSGAME EffiZen ARB19B mini PC", cpuShort: "Ryzen 7 6800H", osShort: "Windows 11", lock: LOCK });
    expect(run.id).toBe("2026-11-12-radeon-680m-win11");
    expect(run.label).toBe("Ryzen 7 6800H / Windows 11, 2026-11-12");
    expect(run.publishedAt).toBe("2026-11-12");
    expect(run.environment.cores).toBe("8 cores / 16 threads");
    expect(run.environment.runtime).toBe("Node 24.22.2 (ESLint, and Biome's launcher); Biome native binary; Bun 1.4.0 harness");
    expect(run.provenance).toEqual({ kind: "fleet", commit: COMMIT, rig: "radeon-680m-win11" });
  });

  test("records the declared packages, scoped Biome included, not its platform binary", () => {
    expect(lineupOf(FLEET_RESULT, LOCK)).toEqual([
      { candidateId: "eslint", package: "eslint", version: "9.34.0", integrity: "sha512-eslinthash==" },
      { candidateId: "biome", package: "@biomejs/biome", version: "2.2.2", integrity: "sha512-biomehash==" },
    ]);
  });

  test("refuses smoke runs, bad commits, version mismatches and results that don't show every file linted", () => {
    expect(() => checkFleetRun(FLEET_RESULT, { allowSmoke: false, commit: COMMIT })).not.toThrow();
    expect(() => checkFleetRun({ ...FLEET_RESULT, smoke: true }, { allowSmoke: false, commit: COMMIT })).toThrow("can't be a smoke run");
    expect(() => checkFleetRun(FLEET_RESULT, { allowSmoke: false, commit: "main" })).toThrow("full SHA");
    const { linted: _, ...unchecked } = FLEET_RESULT;
    expect(() => checkFleetRun(unchecked, { allowSmoke: false, commit: COMMIT })).toThrow("every file");
    const drifted = { ...FLEET_RESULT, candidates: FLEET_RESULT.candidates.map((c) => (c.id === "biome" ? { ...c, reportedVersion: "2.6.5" } : c)) };
    expect(() => checkFleetRun(drifted, { allowSmoke: false, commit: COMMIT })).toThrow("biome reported 2.6.5 at run time but 2.2.2 was installed");
  });

  test("keeps the published run's runtime line for results without Node", () => {
    expect(convertToRun(MOCK_RESULT, {}).environment.runtime).toBe("Bun 1.4.0");
  });
});

describe("authored runs on a fleet rig", () => {
  test("take the rig's slug for the id when given one, so fleet runs on the rig compare with them", () => {
    expect(convertToRun(MOCK_RESULT, { rig: "radeon-680m-win11" }).id).toBe("2026-08-25-radeon-680m-win11");
    expect(convertToRun(MOCK_RESULT, {}).id).toBe("2026-08-25-m2max");
  });
});

describe("release lines", () => {
  test("record an aliased line under the real package, which the fleet's plan matches", () => {
    const result: RunnerResult = {
      ...MOCK_RESULT,
      candidates: [...MOCK_RESULT.candidates, { ...MOCK_RESULT.candidates[0]!, id: "eslint-10", name: "ESLint 10", version: "10.14.0" }],
    };
    const lock = [
      '    "@biomejs/biome": ["@biomejs/biome@2.2.2", "", { "bin": { "biome": "bin/biome" } }, "sha512-biomehash=="],',
      '    "eslint": ["eslint@9.34.0", "", { "bin": { "eslint": "bin/eslint.js" } }, "sha512-nine=="],',
      '    "eslint-10": ["eslint@10.14.0", "", { "dependencies": { "@eslint/core": "^1.0.0" } }, "sha512-ten=="],',
    ].join("\n");
    expect(lineupOf(result, lock).find((entry) => entry.candidateId === "eslint-10")).toEqual({ candidateId: "eslint-10", package: "eslint", version: "10.14.0", integrity: "sha512-ten==" });
  });

  test("give the ESLint 10 line its own color", () => {
    const result: RunnerResult = { ...MOCK_RESULT, candidates: [...MOCK_RESULT.candidates, { ...MOCK_RESULT.candidates[0]!, id: "eslint-10", name: "ESLint 10", version: "10.14.0" }] };
    const colors = convertToRun(result, {}).candidates.map((candidate) => candidate.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
