import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LouError } from "@lou/shared";
import type { CodexCommand } from "./discovery";

/**
 * Compatibility fallback for Codex CLIs without App Server support:
 * `codex exec --json --ephemeral` for single-shot, tool-less completions.
 * Spawned with an argv array; the prompt travels over stdin. Output is the
 * structured JSONL event stream, never human-readable text.
 */
export interface CodexExecOptions {
  command: CodexCommand;
  workspaceDir: string;
  featureArgs: string[];
  env?: NodeJS.ProcessEnv;
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export async function codexExec(options: CodexExecOptions, prompt: string, outputSchema: unknown, signal?: AbortSignal): Promise<string> {
  mkdirSync(options.workspaceDir, { recursive: true });
  const tmp = outputSchema ? mkdtempSync(join(tmpdir(), "lou-codex-schema-")) : undefined;
  const schemaFile = tmp ? join(tmp, "schema.json") : undefined;
  if (schemaFile) writeFileSync(schemaFile, JSON.stringify(outputSchema));

  const args = [
    ...options.command.prefixArgs,
    ...options.featureArgs,
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-C",
    options.workspaceDir,
    ...(options.model ? ["--model", options.model] : []),
    ...(schemaFile ? ["--output-schema", schemaFile] : []),
    "-",
  ];

  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(options.command.file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, cwd: options.workspaceDir, env: { ...(options.env ?? process.env) } });
      const max = options.maxOutputBytes ?? 8 * 1024 * 1024;
      let buffer = "";
      let total = 0;
      let text = "";
      let failure: string | undefined;
      let completed = false;

      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!child.killed && child.exitCode === null) child.kill();
        if (err) reject(err);
        else if (failure) reject(new LouError("MODEL_ERROR", `Codex: ${failure}`));
        else if (!completed) reject(new LouError("UPSTREAM_ERROR", "Codex exited before completing the request."));
        else resolve(text.trim());
      };
      const timer = setTimeout(() => finish(new LouError("TIMEOUT", "Codex took too long to respond.")), options.timeoutMs ?? 120_000);
      const onAbort = () => finish(new LouError("CANCELLED", "Cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        total += chunk.length;
        if (total > max) return finish(new LouError("UPSTREAM_ERROR", "Codex produced too much output."));
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let event: { type?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") text = event.item.text;
          else if (event.type === "turn.completed") completed = true;
          else if (event.type === "turn.failed") failure = event.error?.message ?? "turn failed";
          else if (event.type === "error" && event.message) failure = event.message;
        }
      });
      child.stderr.resume(); // drained, never parsed or logged
      child.on("error", (err) => finish(new LouError("NOT_CONFIGURED", `Couldn't start Codex: ${err.message}`)));
      child.on("close", () => finish());
      child.stdin.end(prompt);
    });
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
