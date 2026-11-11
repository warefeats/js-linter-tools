import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { arch, cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { relativeSpeedup, summarize } from "./stats";
import type { RunnerOptions } from "./options";
import { rigInfo } from "./rig";

// The corpus is ESLint 9.34.0's lib/, the post's, from its npm tarball, whichever ESLint the run measures.
const CORPUS_VERSION = "9.34.0";
const CORPUS_ARCHIVE = `eslint-${CORPUS_VERSION}.tgz`;
const CORPUS_URL = `https://registry.npmjs.org/eslint/-/${CORPUS_ARCHIVE}`;

// A pass that runs this long has hung; the run fails rather than wait out the fleet's job limit.
const PASS_TIMEOUT_MS = 120_000;
// Windows refuses a longer command line.
const WINDOWS_COMMAND_LIMIT = 32_767;

const PROCESS_MODEL = "fresh process per pass, started in the corpus folder, candidates interleaved and rotated each pass";

const ESLINT_RULES = JSON.stringify({
  "no-unused-vars": "error",
  eqeqeq: "error",
  "no-debugger": "error",
  "prefer-const": "error",
});
const ESLINT_ARGS = ["--no-config-lookup", "--no-ignore", "--no-color", "--report-unused-disable-directives-severity", "off", "--rule", ESLINT_RULES];
const BIOME_ARGS = ["lint", "--colors=off", "--max-diagnostics=none", "--error-on-warnings", "--only=correctness/noUnusedVariables", "--only=suspicious/noDoubleEquals", "--only=suspicious/noDebugger", "--only=style/useConst"];

interface CandidateDefinition {
  id: "eslint" | "eslint-10" | "biome";
  name: string;
  version: string;
  reportedVersion: string;
  entry: string;
  command: string[];
  displayCommand: string;
}

interface CandidateResult {
  id: string;
  name: string;
  version: string;
  reportedVersion: string;
  entry: string;
  command: string;
  exitCodes: number[];
  statistics: ReturnType<typeof summarize>;
  samplesMs: number[];
}

/** The sha256 that corpus/checksums.txt pins for `name` ("<sha256>  cache/<file>" lines). */
export function pinnedChecksum(checksums: string, name: string): string {
  for (const line of checksums.split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)\r?$/.exec(line);
    if (match && match[2] === name) return match[1]!;
  }
  throw new Error(`corpus/checksums.txt has no entry for ${name}`);
}

/**
 * The ESLint tarball in corpus/cache, checked against corpus/checksums.txt. A local or CI run downloads it once; the
 * fleet stages it from the rig's cache first, so a fleet run never fetches it.
 */
async function corpusArchive(packageRoot: string): Promise<{ path: string; sha256: string }> {
  const sha256 = pinnedChecksum(await readFile(join(packageRoot, "corpus", "checksums.txt"), "utf8"), `cache/${CORPUS_ARCHIVE}`);
  const path = join(packageRoot, "corpus", "cache", CORPUS_ARCHIVE);
  if (!existsSync(path)) {
    process.stderr.write(`Downloading ${CORPUS_ARCHIVE}\n`);
    const response = await fetch(CORPUS_URL);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const got = createHash("sha256").update(buffer).digest("hex");
    if (got !== sha256) throw new Error(`${CORPUS_URL} has sha256 ${got}, not the ${sha256} corpus/checksums.txt pins`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
  }
  const got = createHash("sha256").update(await readFile(path)).digest("hex");
  if (got !== sha256) throw new Error(`corpus/cache/${CORPUS_ARCHIVE} has sha256 ${got}, not the ${sha256} corpus/checksums.txt pins`);
  return { path, sha256 };
}

const CACHE_MARKER = ".warefeats-verified";

/** The tarball's package/lib, extracted once per archive into tmpdir. */
async function extractCorpus(archive: { path: string; sha256: string }): Promise<string> {
  const cacheDir = join(tmpdir(), `warefeats-eslint-lib-${CORPUS_VERSION}`);
  try {
    await stat(join(cacheDir, "lib"));
    if ((await readFile(join(cacheDir, CACHE_MARKER), "utf8")).trim() === archive.sha256) return join(cacheDir, "lib");
  } catch { /* not extracted yet */ }

  const staging = `${cacheDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(staging, { recursive: true });
  await cp(archive.path, join(staging, "eslint.tgz"));
  // The archive by a relative name: GNU tar (Git Bash's) reads "C:\..." as a remote host.
  const proc = Bun.spawnSync({ cmd: ["tar", "xzf", "eslint.tgz", "--strip-components=1", "package/lib"], cwd: staging, stdout: "ignore", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    await rm(staging, { recursive: true, force: true, maxRetries: 5 });
    throw new Error(`Tar extraction failed: ${proc.stderr.toString()}`);
  }
  await rm(join(staging, "eslint.tgz"));
  await writeFile(join(staging, CACHE_MARKER), `${archive.sha256}\n`);
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 5 });
  await rename(staging, cacheDir);
  process.stderr.write(`Corpus extracted: ESLint ${CORPUS_VERSION} lib\n`);
  return join(cacheDir, "lib");
}

async function javascriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return javascriptFiles(path);
    }

    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  }));

  return nested.flat().sort();
}

async function corpusSize(files: string[]): Promise<{ bytes: number; lines: number }> {
  let bytes = 0;
  let lines = 0;

  for (const file of files) {
    const [metadata, contents] = await Promise.all([stat(file), readFile(file, "utf8")]);
    bytes += metadata.size;
    lines += contents.match(/\n/g)?.length ?? 0;
  }

  return { bytes, lines };
}

/** A pass's wall time. Both linters exit 1 when they report a problem, which this corpus has. */
function measure(command: string[], cwd: string): number {
  const start = performance.now();
  const proc = Bun.spawnSync({ cmd: command, cwd, stdout: "ignore", stderr: "ignore", timeout: PASS_TIMEOUT_MS });
  const durationMs = Math.round((performance.now() - start) * 10) / 10;
  if (proc.exitCode === null || proc.exitCode > 1) {
    const reason = proc.exitCode === null ? `killed after ${PASS_TIMEOUT_MS} ms` : `exit ${proc.exitCode}`;
    throw new Error(`${command.slice(0, 2).join(" ")} failed (${reason}).`);
  }
  return durationMs;
}

/** The candidates in a different order each pass, so each takes every place in turn and drift lands on both. */
export function rotated<T>(items: T[], pass: number): T[] {
  const start = pass % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** Times both linters, interleaved: each warmup and each measured pass lints once with each, in rotated order. */
function runCandidates(defs: CandidateDefinition[], cwd: string, options: RunnerOptions): CandidateResult[] {
  process.stderr.write(`Warming up (${options.warmups} passes of ${defs.length} candidates)\n`);
  for (let pass = 0; pass < options.warmups; pass++) {
    for (const def of rotated(defs, pass)) measure(def.command, cwd);
  }

  process.stderr.write(`Measuring (${options.runs} passes of ${defs.length} candidates)\n`);
  const samples = new Map(defs.map((def) => [def.id, [] as number[]]));
  for (let pass = 0; pass < options.runs; pass++) {
    for (const def of rotated(defs, pass)) samples.get(def.id)!.push(measure(def.command, cwd));
  }

  return defs.map((def) => {
    const samplesMs = samples.get(def.id)!;
    return {
      id: def.id,
      name: def.name,
      version: def.version,
      reportedVersion: def.reportedVersion,
      entry: def.entry,
      command: def.displayCommand,
      exitCodes: [0, 1],
      statistics: summarize(samplesMs),
      samplesMs,
    };
  });
}

/** What ESLint's JSON report says it did: files reported, files it ignored, and rule problems found. */
export function eslintReport(json: string): { files: number; ignored: number; problems: number } {
  const results = JSON.parse(json) as { messages: { ruleId: string | null; message: string }[] }[];
  return {
    files: results.length,
    ignored: results.filter((r) => r.messages.some((m) => m.ruleId === null && /File ignored/.test(m.message))).length,
    problems: results.reduce((sum, r) => sum + r.messages.filter((m) => m.ruleId !== null).length, 0),
  };
}

/** The file count from Biome's summary line, "Checked 391 files in 509ms. No fixes applied." */
export function biomeChecked(output: string): number | null {
  const match = /Checked (\d+) files?/.exec(output);
  return match ? Number(match[1]) : null;
}

/**
 * One unmeasured pass of each linter that must show it linted every file: the published run's ESLint ignored them
 * all as outside its base path and still exited 0.
 */
function checkLinted(defs: CandidateDefinition[], cwd: string, files: number): { eslintProblems: Record<string, number>; biomeChecked: number } {
  const eslintProblems: Record<string, number> = {};
  for (const eslint of defs.filter((def) => def.id !== "biome")) {
    const lint = Bun.spawnSync({ cmd: [...eslint.command, "--format", "json"], cwd, stdout: "pipe", stderr: "pipe", timeout: PASS_TIMEOUT_MS });
    const report = eslintReport(lint.stdout.toString() || "[]");
    if (report.files !== files || report.ignored > 0) {
      throw new Error(`${eslint.name} reported ${report.files} of ${files} files and ignored ${report.ignored}; it has to lint every one.`);
    }
    eslintProblems[eslint.id] = report.problems;
  }
  const biome = defs.find((def) => def.id === "biome")!;
  const check = Bun.spawnSync({ cmd: biome.command, cwd, stdout: "pipe", stderr: "pipe", timeout: PASS_TIMEOUT_MS });
  const checked = biomeChecked(check.stdout.toString() + check.stderr.toString());
  if (checked !== files) throw new Error(`Biome checked ${checked ?? "no"} files of ${files}; it has to check every one.`);
  return { eslintProblems, biomeChecked: checked };
}

async function installedVersion(packageRoot: string, packageName: string): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "node_modules", packageName, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error(`Could not read the installed version of ${packageName}.`);
  }

  return manifest.version;
}

/** A package's command-line script, which `node` runs as the script's shebang would on macOS and Linux. */
async function binEntry(root: string, pkg: string, name: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, "node_modules", pkg, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
  if (!bin) throw new Error(`${pkg} declares no ${name} command`);
  return join(root, "node_modules", pkg, bin);
}

/** The version a CLI prints for itself: ESLint prints "v9.34.0", Biome "Version: 2.2.2". */
export function reportedVersion(output: string): string {
  const last = output.trim().split(/\s+/).at(-1) ?? "";
  return last.replace(/^v/, "");
}

function cliVersion(command: string[], cwd: string): string {
  const proc = Bun.spawnSync({ cmd: [...command, "--version"], cwd, stdout: "pipe", stderr: "pipe", timeout: PASS_TIMEOUT_MS });
  if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} --version failed: ${proc.stderr.toString().slice(0, 300)}`);
  return reportedVersion(proc.stdout.toString());
}

export function detectNodeVersion(): string {
  const proc = Bun.spawnSync({ cmd: ["node", "--version"], stdout: "pipe", stderr: "ignore" });
  if (proc.exitCode !== 0) throw new Error("Failed to detect node version");
  return proc.stdout.toString().trim().replace(/^v/, "");
}

export async function runLintBenchmark(options: RunnerOptions): Promise<Record<string, unknown>> {
  const packageRoot = resolve(import.meta.dir, "..");
  const benchmark = JSON.parse(await readFile(join(packageRoot, "benchmark.json"), "utf8")) as { corpus: { files: number; lines: number; bytes: number } };
  const archive = await corpusArchive(packageRoot);
  const library = await extractCorpus(archive);
  const scratch = await mkdtemp(join(tmpdir(), "warefeats-lint-"));
  const corpusDirectory = join(scratch, "corpus");

  try {
    await cp(library, corpusDirectory, { recursive: true });
    const files = await javascriptFiles(corpusDirectory);
    const size = await corpusSize(files);
    const want = benchmark.corpus;
    if (files.length !== want.files || size.lines !== want.lines || size.bytes !== want.bytes) {
      throw new Error(`The corpus has ${files.length} files, ${size.lines} lines and ${size.bytes} bytes; benchmark.json records ${want.files}, ${want.lines} and ${want.bytes}`);
    }
    // Each linter starts inside the corpus with relative paths: with --no-config-lookup, ESLint ignores every file
    // outside the folder it starts in.
    const paths = files.map((file) => relative(corpusDirectory, file));

    const nodeVersion = detectNodeVersion();
    const biomeScript = await binEntry(packageRoot, "@biomejs/biome", "biome");
    const entryName = (path: string) => path.slice(join(packageRoot, "node_modules").length + 1).replaceAll("\\", "/");
    const biomeVersion = await installedVersion(packageRoot, "@biomejs/biome");
    // One candidate per ESLint release line: the package.json dependency (an npm alias past the first) and its name.
    const eslintLines: { id: "eslint" | "eslint-10"; name: string }[] = [
      { id: "eslint", name: "ESLint 9" },
      { id: "eslint-10", name: "ESLint 10" },
    ];
    const eslints: CandidateDefinition[] = [];
    for (const line of eslintLines) {
      const script = await binEntry(packageRoot, line.id, "eslint");
      eslints.push({
        id: line.id,
        name: line.name,
        version: await installedVersion(packageRoot, line.id),
        reportedVersion: cliVersion(["node", script], corpusDirectory),
        entry: `node ${entryName(script)}`,
        command: ["node", script, ...ESLINT_ARGS, ...paths],
        displayCommand: `eslint --no-config-lookup --no-ignore --rule '${ESLINT_RULES}' **/*.js (run inside the corpus folder)`,
      });
    }

    const definitions: CandidateDefinition[] = [
      ...eslints,
      {
        id: "biome",
        name: "Biome",
        version: biomeVersion,
        reportedVersion: cliVersion(["node", biomeScript], corpusDirectory),
        entry: `node ${entryName(biomeScript)}`,
        command: ["node", biomeScript, ...BIOME_ARGS, ...paths],
        displayCommand: "biome lint --error-on-warnings --only=correctness/noUnusedVariables --only=suspicious/noDoubleEquals --only=suspicious/noDebugger --only=style/useConst **/*.js (run inside the corpus folder)",
      },
    ];
    for (const def of definitions) {
      const length = def.command.join(" ").length;
      if (platform() === "win32" && length > WINDOWS_COMMAND_LIMIT) throw new Error(`${def.name}'s command line runs ${length} characters, past Windows' limit.`);
    }

    const linted = checkLinted(definitions, corpusDirectory, files.length);
    const candidates = runCandidates(definitions, corpusDirectory, options);
    const eslint = candidates.find((candidate) => candidate.id === "eslint");
    const biome = candidates.find((candidate) => candidate.id === "biome");
    if (!eslint || !biome) {
      throw new Error("Both benchmark candidates must run.");
    }

    return {
      schemaVersion: 1,
      benchmark: "eslint-vs-biome-javascript-lint",
      generatedAt: new Date().toISOString(),
      smoke: options.smoke,
      corpus: {
        source: `eslint@${CORPUS_VERSION} npm tarball, package/lib/**/*.js`,
        archive: { name: CORPUS_ARCHIVE, sha256: archive.sha256 },
        files: files.length,
        lines: size.lines,
        bytes: size.bytes,
      },
      linted,
      environment: {
        cpu: cpus()[0]?.model ?? "Unknown CPU",
        logicalCores: cpus().length,
        architecture: arch(),
        platform: platform(),
        release: release(),
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtStart: freemem(),
        bun: Bun.version,
        node: nodeVersion,
      },
      rig: await rigInfo(),
      protocol: {
        warmups: options.warmups,
        runs: options.runs,
        processModel: PROCESS_MODEL,
      },
      candidates,
      speedup: relativeSpeedup(eslint.statistics.medianMs, biome.statistics.medianMs),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

export async function writeResult(result: Record<string, unknown>, output?: string): Promise<void> {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (!output) {
    process.stdout.write(serialized);
    return;
  }

  const destination = resolve(process.cwd(), output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, serialized, "utf8");
  process.stderr.write(`Wrote ${destination}\n`);
}
