import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CodexAgentRuntime,
  CodexAppServerManager,
  CodexModelProvider,
  CustomLunaRuntime,
  ModelRouter,
  OpenAIEmbeddings,
  OpenAIResponsesProvider,
  OpenAITranscriber,
  type AgentRuntime,
  type EmbeddingProvider,
  type ModelProvider,
  type ProviderId,
  type Transcriber,
} from "@lou/agent";
import { newId } from "@lou/shared";
import { BUILTIN_FAMILIES, ToolExecutor, ToolPolicyEngine, ToolRegistry } from "@lou/tools";
import { eq } from "drizzle-orm";
import { ConversationStore } from "./agent/conversations";
import { registerInternalTools } from "./agent/internalTools";
import { DbCodexThreadStore } from "./agent/providerThreads";
import { ModelProviders } from "./agent/providers";
import { ToolCallRecorder } from "./agent/recorder";
import { DbRunStore } from "./agent/runStore";
import { AgentService, ServerContextProvider } from "./agent/service";
import { ApprovalManager } from "./approvals/manager";
import type { Config } from "./config";
import { AuditLog } from "./core/audit";
import { EventBus } from "./core/bus";
import { SettingsStore } from "./core/settings";
import { UserStore, type User } from "./core/users";
import { openDatabase, type Db } from "./db/client";
import { agentRuns, approvals } from "./db/schema";
import { DeviceGateway } from "./devices/gateway";
import { DeviceRegistry } from "./devices/registry";
import { EventManager } from "./events/manager";
import { GoogleConnector } from "./integrations/google/connector";
import { GmailPoller } from "./integrations/google/poller";
import { gmailClientFactory, registerGmailTools } from "./integrations/google/tools";
import type { FetchLike } from "./integrations/http";
import { InstagramConnector } from "./integrations/instagram/connector";
import { IntegrationManager } from "./integrations/manager";
import { McpManager } from "./integrations/mcp/manager";
import { SpotifyConnector } from "./integrations/spotify/connector";
import { SpotifyPlayer } from "./integrations/spotify/player";
import { registerSpotifyTools } from "./integrations/spotify/tools";
import { ImprovementEvaluator } from "./learning/evaluator";
import type { Logger } from "./logger";
import { MemoryStore } from "./memory/store";
import { NotificationManager } from "./notifications/manager";
import { generateMasterKey, hashAction, Vault } from "./security/crypto";
import { SkillRegistry } from "./skills/registry";
import { WorkflowEngine } from "./workflows/engine";

export interface ServiceOverrides {
  fetch?: FetchLike;
  model?: ModelProvider;
  embeddings?: EmbeddingProvider | null;
  transcriber?: Transcriber | null;
  db?: Db;
  /** Spotify client tuning (tests shorten rate-limit waits). */
  spotify?: { maxRateLimitWaitMs?: number; sleep?: (ms: number) => Promise<void> };
  /** Codex App Server overrides (tests point this at a mock app server). */
  codex?: { explicitPath?: string; env?: NodeJS.ProcessEnv };
}

export interface Services {
  config: Config;
  logger: Logger;
  db: Db;
  owner: User;
  bus: EventBus;
  audit: AuditLog;
  settings: SettingsStore;
  users: UserStore;
  devices: DeviceRegistry;
  gateway: DeviceGateway;
  registry: ToolRegistry;
  executor: ToolExecutor;
  approvals: ApprovalManager;
  conversations: ConversationStore;
  runs: DbRunStore;
  /** Runtime for a provider (each run is resumed by the provider that started it). */
  runtimeFor(provider: ProviderId): AgentRuntime;
  providers: ModelProviders;
  codex: CodexAppServerManager;
  agent: AgentService;
  memory: MemoryStore;
  skills: SkillRegistry;
  workflows: WorkflowEngine;
  integrations: IntegrationManager;
  google: GoogleConnector;
  instagram: InstagramConnector;
  spotify: SpotifyConnector;
  spotifyPlayer: SpotifyPlayer;
  mcp: McpManager;
  events: EventManager;
  notifications: NotificationManager;
  improvement?: ImprovementEvaluator;
  gmailPoller: GmailPoller;
  transcriber?: Transcriber;
  /** Single-shot model access following the selected provider. */
  model: ModelProvider;
  /** OpenAI API provider, when configured. */
  apiModel?: ModelProvider;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Resolves the master key; in development a key file is generated once under the data dir. */
function resolveMasterKey(config: Config, logger: Logger): string {
  if (config.masterKey) return config.masterKey;
  const file = join(config.dataDir, "master.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(config.dataDir, { recursive: true });
  const key = generateMasterKey();
  writeFileSync(file, key, { mode: 0o600 });
  logger.warn({ file }, "generated a development master key; set LOU_MASTER_KEY in production");
  return key;
}

export function createServices(config: Config, logger: Logger, overrides: ServiceOverrides = {}): Services {
  const db = overrides.db ?? openDatabase(config.dbPath);
  const vault = new Vault(resolveMasterKey(config, logger));
  const fetchImpl = overrides.fetch ?? fetch;
  const bus = new EventBus(logger);
  const audit = new AuditLog(db);
  const settings = new SettingsStore(db, audit, { aiProvider: config.aiProvider });
  const users = new UserStore(db);
  const owner = users.ensureOwner(config.user);

  const openaiOptions = config.openai.apiKey ? { apiKey: config.openai.apiKey, baseURL: config.openai.baseURL, organization: config.openai.organization } : undefined;
  const apiModel: ModelProvider | undefined =
    overrides.model ??
    (openaiOptions
      ? new OpenAIResponsesProvider({ ...openaiOptions, model: config.openai.model, purposeModels: config.openai.classifierModel ? { classify: config.openai.classifierModel } : undefined })
      : undefined);
  const escalation =
    openaiOptions && config.openai.escalationModel && !overrides.model
      ? { provider: new OpenAIResponsesProvider({ ...openaiOptions, model: config.openai.escalationModel }), afterToolFailures: 2 }
      : undefined;
  const codexManager = new CodexAppServerManager({
    explicitPath: overrides.codex?.explicitPath ?? config.codex.path,
    env: overrides.codex?.env,
    workspaceDir: config.codex.workspaceDir,
    clientVersion: config.version,
    logger,
  });
  const providers = new ModelProviders(
    settings,
    { model: apiModel, modelName: config.openai.model },
    { manager: codexManager, model: new CodexModelProvider(codexManager, { model: config.codex.model }), modelName: config.codex.model },
    logger,
  );
  const model = providers.selected;
  const embeddings = overrides.embeddings === null ? undefined : (overrides.embeddings ?? (openaiOptions ? new OpenAIEmbeddings(openaiOptions, config.openai.embeddingModel) : undefined));
  const transcriber = overrides.transcriber === null ? undefined : (overrides.transcriber ?? (openaiOptions ? new OpenAITranscriber(openaiOptions, config.openai.transcribeModel) : undefined));

  const registry = new ToolRegistry();
  const devices = new DeviceRegistry(db, vault, audit, bus);
  const gateway = new DeviceGateway(db, devices, audit, bus, logger);
  const approvals_ = new ApprovalManager(db, registry, audit, bus);
  const conversations = new ConversationStore(db);
  const runs = new DbRunStore(db, (toolId) => registry.get(toolId)?.title ?? "Working");
  const memory = new MemoryStore(db, audit, logger, embeddings);
  const skills = new SkillRegistry(db, registry, audit, logger, join(config.dataDir, "skills"));
  const integrations = new IntegrationManager(db, vault, audit, logger);
  const notifications = new NotificationManager(db, bus);
  const events = new EventManager(db, notifications, memory, settings, audit, logger, model);
  const google = new GoogleConnector({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, publicUrl: config.publicUrl }, integrations, audit, fetchImpl);
  const instagram = new InstagramConnector(
    { appId: config.instagram.appId, appSecret: config.instagram.appSecret, verifyToken: config.instagram.verifyToken, publicUrl: config.publicUrl },
    integrations,
    audit,
    logger,
    fetchImpl,
  );
  const spotify = new SpotifyConnector(
    { clientId: config.spotify.clientId, clientSecret: config.spotify.clientSecret, redirectUri: config.spotify.redirectUri, api: overrides.spotify },
    integrations,
    settings,
    vault,
    audit,
    logger,
    fetchImpl,
  );
  const spotifyPlayer = new SpotifyPlayer(spotify, integrations);
  const mcp = new McpManager(registry, integrations, logger);

  const userOfRun = (runId: string | undefined) => (runId ? db.select({ u: agentRuns.userId }).from(agentRuns).where(eq(agentRuns.id, runId)).get()?.u : undefined);
  const recorder = new ToolCallRecorder(db, audit, approvals_, userOfRun);

  let executorRef: ToolExecutor | undefined;
  const workflows = new WorkflowEngine(db, registry, () => executorRef!, audit, logger, model, () => owner.name);
  workflows.onApprovalLinked = (approvalId, workflowRunId) => {
    db.update(approvals).set({ workflowRunId }).where(eq(approvals.id, approvalId)).run();
  };

  const executor = new ToolExecutor({
    registry,
    policy: new ToolPolicyEngine(),
    controls: () => settings.controls(),
    resolveDevice: async (userId, requested, origin) => gateway.resolveTarget(userId, requested, origin, (id) => devices.get(id)),
    createApproval: (req) => approvals_.create(req),
    hash: hashAction,
    newId,
    recorder,
  });
  executorRef = executor;

  registerGmailTools(registry, integrations, fetchImpl);
  instagram.registerTools(registry);
  registerSpotifyTools(registry, spotifyPlayer);
  registerInternalTools(registry, { memory, skills, approvals: approvals_, workflows, gateway });

  const improvement = config.improvementEnabled ? new ImprovementEvaluator(db, model, registry, skills, memory, runs, settings, audit, logger) : undefined;

  const runtimes = new Map<ProviderId, AgentRuntime>();
  const runtimeFor = (provider: ProviderId) => runtimes.get(provider)!;
  const agent = new AgentService({
    runtimeFor,
    activeProvider: () => providers.active(),
    providerOfRun: (runId) => runs.providerOf(runId),
    fallbackFor: (provider) => providers.fallbackFor(provider),
    conversations,
    approvals: approvals_,
    workflows,
    settings,
    audit,
    bus,
    logger,
    onRunCompleted: (state) => {
      skills.recordOutcome(state.loadedSkills, state.status === "completed");
      if (improvement?.shouldEvaluate(state)) {
        void improvement.evaluate(state).catch((err) => logger.warn({ err: (err as Error).message }, "improvement evaluation failed"));
      }
    },
  });

  const context = new ServerContextProvider(users, memory, skills, integrations, devices, gateway, conversations);
  const families = () => [...BUILTIN_FAMILIES, ...mcp.families()];
  runtimes.set(
    "openai_api",
    apiModel
      ? new CustomLunaRuntime({ router: new ModelRouter(apiModel, escalation), registry, executor, families, context, runs, progress: agent.progressSink(), logger })
      : unconfiguredRuntime(runs, agent),
  );
  // Same registry, executor (policy + approvals), context and run store; only the reasoning backend differs.
  runtimes.set(
    "codex_cli",
    new CodexAgentRuntime({
      manager: codexManager,
      registry,
      executor,
      families,
      context,
      runs,
      threads: new DbCodexThreadStore(db),
      progress: agent.progressSink(),
      logger,
      model: config.codex.model,
      turnTimeoutMs: config.codex.turnTimeoutMs,
    }),
  );

  const gmailPoller = new GmailPoller(integrations, gmailClientFactory(integrations, fetchImpl), events, logger, config.google.pollSeconds * 1000, () => !settings.get().monitoringDisabled);

  let expiryTimer: ReturnType<typeof setInterval> | undefined;

  return {
    config,
    logger,
    db,
    owner,
    bus,
    audit,
    settings,
    users,
    devices,
    gateway,
    registry,
    executor,
    approvals: approvals_,
    conversations,
    runs,
    runtimeFor,
    providers,
    codex: codexManager,
    agent,
    memory,
    skills,
    workflows,
    integrations,
    google,
    instagram,
    spotify,
    spotifyPlayer,
    mcp,
    events,
    notifications,
    improvement,
    gmailPoller,
    transcriber,
    model,
    apiModel,
    async start() {
      const recovered = runs.recoverInterrupted();
      if (recovered) logger.warn({ recovered }, "marked interrupted runs as failed");
      const synced = await skills.syncBuiltins(config.skillsDir);
      logger.info({ ...synced, dir: config.skillsDir }, "skills loaded");
      workflows.syncBuiltins();
      await mcp.start(config.mcpConfigPath, owner.id);
      if (google.configured) gmailPoller.start();
      expiryTimer = setInterval(() => void approvals_.expireStale().catch((err) => logger.warn({ err }, "approval expiry failed")), 60_000);
      expiryTimer.unref();
      logger.info({ provider: providers.active() }, "model provider selected");
      if (providers.active() === "openai_api" && !apiModel) logger.warn("OPENAI_API_KEY is not set: the agent will report that it is not configured");
      providers.warmUp();
    },
    async stop() {
      if (expiryTimer) clearInterval(expiryTimer);
      gmailPoller.stop();
      gateway.close();
      await mcp.stop();
      await codexManager.stop();
      db.$client.close();
    },
  };
}

/** Runtime used when no model is configured: every run fails with an actionable message. */
function unconfiguredRuntime(runs: DbRunStore, agent: AgentService): AgentRuntime {
  const sink = agent.progressSink();
  return {
    async run(input) {
      const state = {
        runId: input.runId,
        userId: input.userId,
        conversationId: input.conversationId,
        originDeviceId: input.originDeviceId,
        source: input.source,
        status: "failed" as const,
        request: input.text,
        model: "none",
        transcript: [],
        exposedTools: [],
        loadedSkills: [],
        tainted: false,
        step: 0,
        consecutiveFailures: 0,
        pending: null,
        queue: [],
        finalMessage: null,
        error: { code: "NOT_CONFIGURED" as const, message: "The assistant model isn't configured on the server (OPENAI_API_KEY).", retryable: false },
        actionsTaken: 0,
      };
      await runs.create(state);
      await runs.save(state);
      sink.completed(state);
      return { runId: input.runId, status: "failed", finalMessage: null, approvalId: null, error: state.error };
    },
    async resume(runId) {
      return { runId, status: "failed", finalMessage: null, approvalId: null, error: { code: "NOT_CONFIGURED", message: "No model configured.", retryable: false } };
    },
    async cancel() {},
  };
}
