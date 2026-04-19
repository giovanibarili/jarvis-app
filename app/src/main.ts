// src/main.ts
import { EventBus } from "./core/bus.js";
import { SessionManager } from "./core/session-manager.js";
import { JarvisCore } from "./core/jarvis.js";
import { HudState } from "./core/hud-state.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { CapabilityExecutor } from "./capabilities/executor.js";
import { CapabilityLoaderPiece } from "./capabilities/loader.js";
import { McpManager } from "./mcp/manager.js";
import { ChatPiece } from "./input/chat-piece.js";
import { GrpcPiece } from "./input/grpc-piece.js";
import { HttpServer } from "./server.js";
import { PieceManager } from "./core/piece-manager.js";
import { PluginManager } from "./core/plugin-manager.js";
import { CronPiece } from "./core/cron-piece.js";
import type { Piece } from "./core/piece.js";
import { log } from "./logger/index.js";
import { clearAllConversations } from "./core/conversation-store.js";
import { launchHud } from "./transport/hud/electron.js";
import { config, setModel, getValidModels, getCurrentProvider } from "./config/index.js";
import { ProviderRouter } from "./ai/provider.js";
import { createAnthropicProvider } from "./ai/anthropic/provider.js";
import { createOpenAIProvider } from "./ai/openai/provider.js";
import { AnthropicSessionFactory } from "./ai/anthropic/factory.js";
import { registerSessionInspectorTools } from "./ai/anthropic/session-inspector.js";
import { HudCoreNodePiece } from "./core/hud-core-node.js";
import { DiffViewerPiece } from "./pieces/diff-viewer.js";

async function main() {
  const bus = new EventBus();
  const capabilityRegistry = new CapabilityRegistry();

  const chatPiece = new ChatPiece();
  chatPiece.setRegistry(capabilityRegistry);
  // sessions wired later after SessionManager is created
  const jarvisCore = new JarvisCore();

  const pieces: Piece[] = [
    jarvisCore,
    new CapabilityExecutor(capabilityRegistry),
    new CapabilityLoaderPiece(capabilityRegistry),
    new McpManager(capabilityRegistry),
    new GrpcPiece(capabilityRegistry),
    chatPiece,
  ];

  // Provider router — manages active AI provider + metrics HUD
  // Find the plugin manager piece lazily (it's in the pieces array)
  const getPluginManager = () => pieces.find(p => p.id === "plugin-manager") as any;
  const providerRouter = new ProviderRouter({
    getTools: () => capabilityRegistry.getDefinitions(),
    getCoreContext: () => pieces.filter(p => p.id !== "plugin-manager" && p.systemContext).map(p => p.systemContext!()),
    getPluginInstructions: () => {
      const pm = getPluginManager();
      return pm?.systemContext ? [pm.systemContext()] : [];
    },
    getPluginContext: (sessionId?: string) => {
      const pm = getPluginManager();
      return pm?.pluginPieceContext ? [pm.pluginPieceContext(sessionId)] : [];
    },
    getInstructions: () => jarvisCore.getJarvisMd(),
  });
  providerRouter.registerProviderFactory("anthropic", createAnthropicProvider);
  providerRouter.registerProviderFactory("openai", createOpenAIProvider);

  // SessionManager — factory set after provider activation
  const sessions = new SessionManager(null as any);
  jarvisCore.setSessions(sessions);
  chatPiece.setSessions(sessions);

  // Model management tools — now provider-aware
  capabilityRegistry.register({
    name: "model_set",
    description: `Switch the AI model. Examples: claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-7, gpt-4o, gpt-4o-mini, o3. Anthropic models use Claude, others use OpenAI-compatible API.`,
    input_schema: {
      type: "object",
      properties: { model: { type: "string", description: "Model ID to switch to" } },
      required: ["model"],
    },
    handler: async (input) => {
      const result = setModel(input.model as string);
      if (result.providerChanged) {
        await providerRouter.switchTo(result.provider, bus);
        sessions.updateFactory(providerRouter.getFactory());
        sessions.setProvider(result.provider);
        jarvisCore.abortSession("main");
      }
      return result.message;
    },
  });
  capabilityRegistry.register({
    name: "model_get",
    description: "Get the current AI model and provider being used.",
    input_schema: { type: "object", properties: {} },
    handler: async () => ({
      model: config.model,
      provider: getCurrentProvider(),
      available: getValidModels(),
    }),
  });

  // Runtime eval — full access to JARVIS internals
  capabilityRegistry.register({
    name: "jarvis_eval",
    description: "Execute JavaScript code inside the running JARVIS process. Has access to: bus, capabilityRegistry, sessions, providerRouter, config, pieces, jarvisCore, chatPiece, and all runtime objects. Use for introspection, debugging, testing, or calling any internal function. Returns the expression result (or last statement). Async code supported.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to execute in the JARVIS runtime context" },
      },
      required: ["code"],
    },
    handler: async (input) => {
      const code = input.code as string;
      const context = { bus, capabilityRegistry, sessions, providerRouter, config, pieces, jarvisCore, chatPiece, log, setModel, getCurrentProvider, getValidModels };
      try {
        const keys = Object.keys(context);
        const values = Object.values(context);
        const asyncFn = new Function(...keys, `return (async () => { ${code} })()`);
        const result = await asyncFn(...values);
        return { result: result !== undefined ? String(result) : "undefined" };
      } catch (err: any) {
        return { error: err.message, stack: err.stack };
      }
    },
  });

  // Core Node graph visualization
  pieces.push(new HudCoreNodePiece());

  // Diff Viewer — file visualization, diff, and comparison in HUD
  pieces.push(new DiffViewerPiece(capabilityRegistry));

  // Cron scheduler
  pieces.push(new CronPiece(capabilityRegistry));

  // Plugin manager
  const pluginManager = new PluginManager(capabilityRegistry);
  pieces.push(pluginManager);

  const hudState = new HudState(bus);

  // Activate initial provider AFTER HudState exists (so metrics HUD registers)
  await providerRouter.switchTo(getCurrentProvider(), bus);
  sessions.updateFactory(providerRouter.getFactory());
  sessions.setProvider(getCurrentProvider());
  sessions.startAutoSave();
  pluginManager.setFactory(providerRouter.getFactory());

  // Register session inspector tools (Anthropic-only — exposes session, history, system prompt, tools)
  const activeFactory = providerRouter.getFactory();
  if (activeFactory instanceof AnthropicSessionFactory) {
    registerSessionInspectorTools(capabilityRegistry, sessions, activeFactory);
  }

  const pieceManager = new PieceManager(pieces, bus, capabilityRegistry);
  pluginManager.setPieceManager(pieceManager);

  const server = new HttpServer(50052, chatPiece, () => hudState.getState(), () => jarvisCore.abortSession("main"), () => capabilityRegistry.getSlashCommands());
  server.setHudStreamHandler((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    // Send full snapshot first so client has complete state
    res.write(`data: ${JSON.stringify({ action: "snapshot", state: hudState.getState() })}\n\n`);
    hudState.addStreamClient(res);
    _req.on("close", () => hudState.removeStreamClient(res));
  });
  server.setOnClearSession(() => {
    log.info("ClearSession: clearing conversation and resetting session");
    jarvisCore.abortSession("main");
    sessions.closeAll();
    clearAllConversations();
    // Broadcast to chat UI so it clears the timeline
    chatPiece.broadcastEvent({ type: "session_cleared" });
  });
  pluginManager.setHttpServer(server);

  await pieceManager.startAll();

  console.log("JARVIS starting...");
  console.log(`HUD  ${server.url}\n`);
  launchHud(server.url);
  jarvisCore.ready();
  console.log("JARVIS online\n");

  process.on("SIGINT", async () => {
    log.info("Shutting down...");
    sessions.stopAutoSave();
    sessions.saveAll();
    await pieceManager.stopAll();
    const activeProvider = providerRouter.getActiveProvider();
    if (activeProvider) await activeProvider.metricsPiece.stop();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => { log.fatal({ err }, "Startup failed"); process.exit(1); });
