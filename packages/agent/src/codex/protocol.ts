/**
 * The subset of the Codex App Server protocol (newline-delimited JSON-RPC over
 * stdio) that Lou uses. Shapes follow `codex app-server generate-ts --experimental`
 * (CLI 0.151). Kept deliberately small: everything Codex-specific stays inside
 * packages/agent/src/codex and is converted to provider-neutral types there.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Outgoing request / incoming response. The App Server omits the `jsonrpc` field. */
export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

/** Requests initiated by the server (e.g. dynamic tool calls, approvals). */
export interface RpcServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type CodexAccount =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: string }
  | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean };

export interface GetAccountResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

export interface DynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write";
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  dynamicTools?: DynamicToolSpec[] | null;
}

export interface ThreadInfo {
  id: string;
}

export interface ThreadStartResponse {
  thread: ThreadInfo;
  model: string;
  instructionSources?: string[];
  approvalPolicy: unknown;
  sandbox: { type: string };
}

export interface UserTextInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface TurnStartParams {
  threadId: string;
  input: UserTextInput[];
  model?: string | null;
  outputSchema?: JsonValue | null;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

export interface ThreadItem {
  type: string;
  id: string;
  text?: string;
  phase?: string | null;
  tool?: string;
  [key: string]: unknown;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
}

export interface DynamicToolCallResponse {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
}

export interface McpServerStatus {
  name: string;
  tools?: Record<string, unknown>;
}

/**
 * Thread items that mean Codex used one of its *own* capabilities rather than
 * Lou's registered tools. They are disabled at launch; seeing one anyway is
 * treated as a security violation and the turn is interrupted.
 */
export const FORBIDDEN_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "imageGeneration",
  "imageView",
  "collabAgentToolCall",
  "subAgentActivity",
]);

/** Server requests asking the client to approve Codex-native actions. Lou always declines them. */
export const CODEX_APPROVAL_REQUESTS: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);
