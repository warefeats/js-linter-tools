import { describe, expect, test } from "bun:test";
import { biomeChecked, eslintReport, pinnedChecksum, reportedVersion, rotated } from "../src/run";

describe("pinnedChecksum", () => {
  const sums = "# a comment\n81f36e48bdafe1b9816d9d08f84af098919aa5bb83bacc7a1e04613d86849146  cache/eslint-9.34.0.tgz\r\n";

  test("reads the archive's sha256, past comments and CRLF", () => {
    expect(pinnedChecksum(sums, "cache/eslint-9.34.0.tgz")).toBe("81f36e48bdafe1b9816d9d08f84af098919aa5bb83bacc7a1e04613d86849146");
  });

  test("refuses an archive it doesn't list", () => {
    expect(() => pinnedChecksum(sums, "cache/eslint-10.0.0.tgz")).toThrow("no entry for cache/eslint-10.0.0.tgz");
  });
});

describe("rotated", () => {
  test("alternates which linter goes first", () => {
    expect(rotated(["eslint", "biome"], 0)).toEqual(["eslint", "biome"]);
    expect(rotated(["eslint", "biome"], 1)).toEqual(["biome", "eslint"]);
    expect(rotated(["eslint", "biome"], 2)).toEqual(["eslint", "biome"]);
  });
});

describe("reportedVersion", () => {
  test("reads ESLint's v-prefixed version and Biome's labelled one", () => {
    expect(reportedVersion("v9.34.0\n")).toBe("9.34.0");
    expect(reportedVersion("Version: 2.2.2\n")).toBe("2.2.2");
  });
});

describe("eslintReport", () => {
  test("counts the files ESLint ignored as outside its base path, as the published run's were", () => {
    const ignored = JSON.stringify([
      { filePath: "a.js", messages: [{ ruleId: null, message: "File ignored because outside of base path." }] },
      { filePath: "b.js", messages: [{ ruleId: null, message: "File ignored because outside of base path." }] },
    ]);
    expect(eslintReport(ignored)).toEqual({ files: 2, ignored: 2, problems: 0 });
  });

  test("counts rule problems in linted files", () => {
    const linted = JSON.stringify([
      { filePath: "a.js", messages: [{ ruleId: "prefer-const", message: "'x' is never reassigned." }, { ruleId: "eqeqeq", message: "Expected '==='." }] },
      { filePath: "b.js", messages: [] },
    ]);
    expect(eslintReport(linted)).toEqual({ files: 2, ignored: 0, problems: 2 });
  });
});

describe("biomeChecked", () => {
  test("reads the file count from Biome's summary", () => {
    expect(biomeChecked("lint ━━━━━━━━\nChecked 391 files in 509ms. No fixes applied.\nFound 2 warnings.")).toBe(391);
    expect(biomeChecked("Checked 1 file in 3ms.")).toBe(1);
    expect(biomeChecked("error: No files were processed")).toBeNull();
  });
});
