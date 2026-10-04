import { readFile } from "node:fs/promises";
import { LouError, type RiskLevel } from "@lou/shared";
import type { ToolFamily, ToolRegistry } from "@lou/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { Logger } from "../../logger";
import type { IntegrationManager } from "../manager";

const ServerConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "lowercase id"),
  name: z.string(),
  description: z.string().default("Tools from an external MCP server."),
  transport: z.enum(["http", "sse", "stdio"]),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Glob patterns of tool names to expose (default: all). */
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  /** Tools the operator vouches are read-only. Everything else is treated as a write requiring approval. */
  readOnlyTools: z.array(z.string()).default([]),
  /** Keywords that select this server's tool family for a request. */
  keywords: z.array(z.string()).default([]),
  /** Max tools offered to the model per request (most relevant first). */
  maxToolsPerRequest: z.number().int().min(1).max(30).default(8),
});
export type McpServerConfig = z.infer<typeof ServerConfigSchema>;

const ConfigFileSchema = z.object({ servers: z.array(ServerConfigSchema).default([]) });

interface Connected {
  config: McpServerConfig;
  client: Client;
  toolIds: string[];
}

/**
 * MCP client layer. Each configured server (e.g. Zapier MCP) is connected,
 * its tools discovered, filtered, and registered as ordinary internal tools
 * (`mcp.<server>.<tool>`) so the rest of the system never deals with MCP.
 * Safety defaults: every MCP tool is a write requiring approval unless the
 * operator lists it in `readOnlyTools`; server-provided hints never relax that.
 */
export class McpManager {
  private readonly connected = new Map<string, Connected>();
  private readonly familyList: ToolFamily[] = [];

  constructor(
    private readonly registry: ToolRegistry,
    private readonly integrations: IntegrationManager,
    private readonly logger: Logger,
  ) {}

  families(): readonly ToolFamily[] {
    return this.familyList;
  }

  async start(configPath: string | undefined, userId: string): Promise<void> {
    if (!configPath) return;
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch (err) {
      this.logger.warn({ err, configPath }, "MCP config not readable; skipping MCP");
      return;
    }
    const parsed = ConfigFileSchema.safeParse(JSON.parse(substituteEnv(raw)));
    if (!parsed.success) {
      this.logger.error({ issues: parsed.error.issues }, "invalid MCP config");
      return;
    }
    await Promise.all(parsed.data.servers.map((server) => this.connect(server, userId)));
  }

  async stop(): Promise<void> {
    for (const c of this.connected.values()) await c.client.close().catch(() => undefined);
    this.connected.clear();
  }

  private async connect(config: McpServerConfig, userId: string): Promise<void> {
    const accountId = this.integrations.upsertAccount({
      userId,
      provider: "mcp",
      externalId: config.id,
      displayName: config.name,
      address: config.transport === "stdio" ? config.command ?? null : redactUrl(config.url),
      capabilities: [],
    });
    try {
      const client = new Client({ name: "lou-server", version: "0.1.0" });
      await client.connect(this.transport(config));
      const { tools } = await client.listTools();
      const selected = tools.filter((t) => matches(t.name, config.include ?? ["*"]) && !matches(t.name, config.exclude ?? []));
      const toolIds: string[] = [];
      for (const tool of selected) {
        const id = `mcp.${config.id}.${tool.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`.slice(0, 64);
        if (this.registry.has(id)) continue;
        const readOnly = config.readOnlyTools.some((p) => matches(tool.name, [p]));
        const risk: RiskLevel = readOnly ? "read" : tool.annotations?.destructiveHint ? "destructive" : "write";
        this.registry.register(
          {
            id,
            family: `mcp.${config.id}`,
            title: `Using ${config.name}`,
            description: `[${config.name}] ${(tool.description ?? tool.name).slice(0, 600)}`,
            input: z.record(z.string(), z.unknown()),
            inputJsonSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
            risk,
            executionTarget: "server",
            requiresApproval: risk !== "read",
            exposure: "model",
            untrustedOutput: true,
          },
          {
            execute: async (input, ctx) => {
              const result = await client.callTool({ name: tool.name, arguments: input }, undefined, { signal: ctx.signal });
              if (result.isError) throw new LouError("UPSTREAM_ERROR", `${config.name}: ${flattenContent(result.content).slice(0, 500)}`);
              return { content: flattenContent(result.content).slice(0, 12_000), structured: result.structuredContent ?? null };
            },
          },
        );
        toolIds.push(id);
      }
      this.connected.set(config.id, { config, client, toolIds });
      this.familyList.push({
        id: `mcp.${config.id}`,
        description: `${config.name}: ${config.description}`,
        keywords: [config.id, config.name.toLowerCase(), ...config.keywords.map((k) => k.toLowerCase())],
        maxTools: config.maxToolsPerRequest,
      });
      this.integrations.upsertAccount({ userId, provider: "mcp", externalId: config.id, displayName: config.name, address: config.transport === "stdio" ? config.command ?? null : redactUrl(config.url), capabilities: toolIds.map((t) => t.split(".").slice(2).join(".")) });
      this.integrations.setStatus(accountId, "connected", null);
      this.logger.info({ server: config.id, tools: toolIds.length, discovered: tools.length }, "MCP server connected");
    } catch (err) {
      this.integrations.setStatus(accountId, "error", (err as Error).message.slice(0, 300));
      this.logger.error({ err, server: config.id }, "MCP server connection failed");
    }
  }

  private transport(config: McpServerConfig) {
    if (config.transport === "stdio") {
      if (!config.command) throw new Error(`MCP server ${config.id}: command is required for stdio`);
      return new StdioClientTransport({ command: config.command, args: config.args ?? [], env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) } });
    }
    if (!config.url) throw new Error(`MCP server ${config.id}: url is required`);
    const requestInit = config.headers ? { headers: config.headers } : undefined;
    return config.transport === "sse"
      ? new SSEClientTransport(new URL(config.url), { requestInit })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
  }
}

/** `${VAR}` substitution so secrets live in the environment, not the config file. */
export function substituteEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => JSON.stringify(env[name] ?? "").slice(1, -1));
}

function matches(name: string, patterns: string[]): boolean {
  return patterns.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(name));
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : c.type ? `[${c.type}]` : ""))
    .join("\n")
    .trim();
}

function redactUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
