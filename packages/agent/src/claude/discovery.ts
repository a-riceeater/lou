import { describeMissingCli, findCliExecutable, type CliCommand, type CliDiscoveryOptions } from "../cli";

export type ClaudeCommand = CliCommand;

/**
 * Finds the `claude` executable on PATH (or an explicit CLAUDE_PATH). The native
 * installer puts it in ~/.local/bin and older local installs in ~/.claude/local,
 * neither of which is on a service's PATH, so both are searched too.
 */
export function findClaudeExecutable(options: CliDiscoveryOptions = {}): ClaudeCommand | undefined {
  return findCliExecutable(
    {
      name: "claude",
      homeDirs: () => [
        [".local", "bin"],
        [".claude", "local"],
      ],
    },
    options,
  );
}

/** Explains why claude wasn't found, so a misconfigured CLAUDE_PATH is diagnosable from the status screen. */
export function describeMissingClaude(explicitPath: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return describeMissingCli("Claude Code", "CLAUDE_PATH", explicitPath, env);
}
