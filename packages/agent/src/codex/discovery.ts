import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeMissingCli, findCliExecutable, isFile, pathDirs, readCliVersion, type CliCommand, type CliDiscoveryOptions } from "../cli";

export { resolveShimScript } from "../cli";

/**
 * Locating and launching the Codex CLI without a shell. Everything here returns
 * an argv array; user text never reaches a command line.
 */
export type CodexCommand = CliCommand;
export type DiscoveryOptions = CliDiscoveryOptions;

/** Finds the codex executable on PATH (or an explicit path) and returns how to launch it. */
export function findCodexExecutable(options: DiscoveryOptions = {}): CodexCommand | undefined {
  // Services (systemd, cron) get a minimal PATH without the user's ~/.local/bin, where the codex installer puts it.
  return findCliExecutable({ name: "codex", homeDirs: (platform) => (platform === "win32" ? [] : [[".local", "bin"]]) }, options);
}

/** Explains why codex wasn't found, so a misconfigured CODEX_PATH is diagnosable from the status screen. */
export function describeMissingCodex(explicitPath: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return describeMissingCli("Codex", "CODEX_PATH", explicitPath, env);
}

/**
 * Code-only Codex models call tools through the code-mode host, a separate
 * `codex-code-mode-host` executable installed beside `codex`. Copying just the
 * `codex` binary (e.g. out of ~/.local/bin) leaves it behind, and then every
 * tool call fails inside Codex. Returns the binary's real path when its host is
 * missing; npm installs (a JS launcher) locate their own vendored host.
 */
export function missingCodeModeHost(command: CodexCommand, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (command.prefixArgs.length) return undefined;
  let real: string;
  try {
    real = realpathSync(command.file);
  } catch {
    return undefined;
  }
  if (/\.(c|m)?js$/i.test(real)) return undefined;
  const name = platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
  const dirs = [dirname(real), ...pathDirs(env, platform)];
  return dirs.some((dir) => isFile(join(dir, name))) ? undefined : real;
}

/** Runs `codex --version` (argv only, 10 s timeout) and returns e.g. "0.151.0". */
export function readCodexVersion(command: CodexCommand, timeoutMs = 10_000): Promise<string | undefined> {
  return readCliVersion(command, timeoutMs);
}
