import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { missingCodeModeHost } from "../src";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  return path;
}

describe("missingCodeModeHost", () => {
  it("flags a codex binary copied without its code-mode host", () => {
    dir = mkdtempSync(join(tmpdir(), "lou-codex-"));
    const codex = file(join(dir, "bin", "codex"));
    const command = { file: codex, prefixArgs: [], resolvedPath: codex };
    expect(missingCodeModeHost(command, { PATH: "" }, "linux")).toBe(codex);

    file(join(dir, "bin", "codex-code-mode-host"));
    expect(missingCodeModeHost(command, { PATH: "" }, "linux")).toBeUndefined();
  });

  it("accepts a host on PATH and leaves npm launchers alone", () => {
    dir = mkdtempSync(join(tmpdir(), "lou-codex-"));
    const codex = file(join(dir, "bin", "codex"));
    file(join(dir, "elsewhere", "codex-code-mode-host"));
    expect(missingCodeModeHost({ file: codex, prefixArgs: [], resolvedPath: codex }, { PATH: join(dir, "elsewhere") }, "linux")).toBeUndefined();

    const script = file(join(dir, "npm", "codex.js"));
    expect(missingCodeModeHost({ file: process.execPath, prefixArgs: [script], resolvedPath: script }, { PATH: "" }, "linux")).toBeUndefined();
  });
});
