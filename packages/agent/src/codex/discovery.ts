import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

/**
 * Locating and launching the Codex CLI without a shell. Everything here returns
 * an argv array; user text never reaches a command line.
 */
export interface CodexCommand {
  /** Executable to spawn (codex binary or node for script entries). */
  file: string;
  /** Leading arguments (e.g. the JS entry script when `file` is node). */
  prefixArgs: string[];
  /** What was found, for status display. */
  resolvedPath: string;
}

export interface DiscoveryOptions {
  /** Explicit path from configuration (CODEX_PATH / LOU_CODEX_PATH). */
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodePath?: string;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Finds the codex executable on PATH (or an explicit path) and returns how to launch it. */
export function findCodexExecutable(options: DiscoveryOptions = {}): CodexCommand | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;

  const candidates: string[] = [];
  if (options.explicitPath) candidates.push(expandPath(options.explicitPath, env));
  else {
    const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex.ps1", "codex"] : ["codex"];
    const pathVar = env.PATH ?? env.Path ?? "";
    const dirs = pathVar.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
    // Services (systemd, cron) get a minimal PATH without the user's ~/.local/bin, where the codex installer puts it.
    const home = env.HOME ?? homedir();
    if (platform !== "win32" && home) dirs.push(join(home, ".local", "bin"));
    for (const dir of dirs) {
      for (const name of names) candidates.push(join(dir.replace(/^"|"$/g, ""), name));
    }
  }

  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    const command = toCommand(candidate, platform, nodePath);
    if (command) return command;
  }
  return undefined;
}

/** Resolves a configured path, expanding a leading `~` (shells do this, .env files don't). */
function expandPath(path: string, env: NodeJS.ProcessEnv): string {
  const trimmed = path.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (trimmed === "~" || /^~[\\/]/.test(trimmed)) return join(env.HOME ?? env.USERPROFILE ?? homedir(), trimmed.slice(1));
  return resolve(trimmed);
}

/** Explains why codex wasn't found, so a misconfigured CODEX_PATH is diagnosable from the status screen. */
export function describeMissingCodex(explicitPath: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!explicitPath) return "Codex executable not found on PATH (set CODEX_PATH to its full path)";
  const path = expandPath(explicitPath, env);
  let user = "this user";
  try {
    user = `user ${userInfo().username}`;
  } catch {}
  try {
    if (statSync(path).isDirectory()) return `CODEX_PATH ${path} is a directory; point it at the codex executable itself`;
    return `CODEX_PATH ${path} can't be launched by ${user}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") return `CODEX_PATH ${path} isn't readable by ${user}; the server must run as a user that can reach it`;
    const hidden = /^\/(home|root|run\/user)\//.test(path) ? " (under systemd, ProtectHome=true hides /home and /root from the service)" : "";
    return `CODEX_PATH ${path} doesn't exist as seen by the server${hidden}`;
  }
}

function toCommand(path: string, platform: NodeJS.Platform, nodePath: string): CodexCommand | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { file: nodePath, prefixArgs: [path], resolvedPath: path };
  if (platform === "win32" && (ext === ".cmd" || ext === ".bat" || ext === ".ps1")) {
    // npm shims can't be spawned without a shell; run their JS entry with node instead.
    const script = resolveShimScript(path);
    return script ? { file: nodePath, prefixArgs: [script], resolvedPath: path } : undefined;
  }
  if (platform === "win32" && ext === "") {
    // Extensionless files on Windows are usually sh shims next to a .cmd/.exe; skip.
    return existsSync(`${path}.exe`) ? { file: `${path}.exe`, prefixArgs: [], resolvedPath: `${path}.exe` } : undefined;
  }
  return { file: path, prefixArgs: [], resolvedPath: path };
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
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = [dirname(real), ...pathVar.split(platform === "win32" ? ";" : delimiter).filter(Boolean)];
  return dirs.some((dir) => isFile(join(dir.replace(/^"|"$/g, ""), name))) ? undefined : real;
}

/** Extracts the JS entry point from an npm-generated .cmd/.ps1 shim. */
export function resolveShimScript(shimPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  const match = /["']?(?:%~?dp0%?|%dp0%|\$basedir)[\\/]+([^"'\r\n]+?\.(?:c|m)?js)["']?/i.exec(text);
  if (!match?.[1]) return undefined;
  const script = join(dirname(shimPath), match[1].replace(/[\\/]+/g, "/"));
  return isAbsolute(script) && isFile(script) ? script : undefined;
}

/** Runs `codex --version` (argv only, 10 s timeout) and returns e.g. "0.151.0". */
export function readCodexVersion(command: CodexCommand, timeoutMs = 10_000): Promise<string | undefined> {
  return new Promise((resolveVersion) => {
    let out = "";
    let done = false;
    const child = spawn(command.file, [...command.prefixArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveVersion(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 4096) out += d.toString();
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(/(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/.exec(out)?.[1]));
  });
}
