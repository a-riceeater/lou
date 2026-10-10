import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Name of Lou's MCP server inside Claude Code; tools appear as `mcp__lou__<name>`. */
export const LOU_MCP_SERVER = "lou";

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

/** The tools of one Claude turn and how to run them. */
export interface BridgeSession {
  tools: McpToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface BridgeLease {
  url: string;
  token: string;
  close(): void;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

/**
 * Loopback MCP server (Streamable HTTP, JSON responses, no server-sent stream)
 * that exposes Lou's registered tools to Claude Code. It listens on 127.0.0.1
 * only, rejects foreign Host headers (DNS rebinding), and every request needs
 * the bearer token of an open turn, which also selects that turn's tools. Tool
 * calls are handed to the turn's callback, i.e. Lou's ToolExecutor.
 */
export class LouToolBridge {
  private server: Server | undefined;
  private starting: Promise<number> | undefined;
  private port = 0;
  private readonly sessions = new Map<string, BridgeSession>();

  /** Registers a turn's tools and returns where Claude Code can reach them. */
  async open(session: BridgeSession): Promise<BridgeLease> {
    const port = await this.listen();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, session);
    return { url: `http://127.0.0.1:${port}/mcp`, token, close: () => void this.sessions.delete(token) };
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private listen(): Promise<number> {
    if (this.server) return Promise.resolve(this.port);
    this.starting ??= new Promise<number>((resolveListen, rejectListen) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        resolveListen(this.port);
      });
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return end(res, 403);
    if ((req.url ?? "").split("?")[0] !== "/mcp") return end(res, 404);
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const session = token ? this.sessions.get(token) : undefined;
    if (!session) return end(res, 401);
    if (req.method !== "POST") return end(res, 405, undefined, { allow: "POST" });

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return end(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const messages = (Array.isArray(body) ? body : [body]) as RpcMessage[];
    const replies = (await Promise.all(messages.map((m) => this.dispatch(session, m)))).filter((r) => r !== undefined);
    if (!replies.length) return end(res, 202);
    end(res, 200, Array.isArray(body) ? replies : replies[0]);
  }

  private async dispatch(session: BridgeSession, msg: RpcMessage): Promise<object | undefined> {
    // Notifications (no id) and responses need no reply.
    if (msg.id === undefined || msg.id === null || !msg.method) return undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: LOU_MCP_SERVER, title: "Lou", version: "1.0.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: session.tools });
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string" || !session.tools.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
        const args = msg.params?.arguments;
        try {
          const result = await session.call(name, args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {});
          return ok({ content: [{ type: "text", text: result.text }], isError: result.isError });
        } catch (err) {
          return ok({ content: [{ type: "text", text: (err as Error).message }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function end(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, { ...headers, "content-type": "application/json" }).end(JSON.stringify(body));
}
