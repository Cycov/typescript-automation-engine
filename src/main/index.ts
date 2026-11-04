/**
 * TypeScript Automation Engine — Main Entry Point
 *
 * Orchestrates:
 * - Express HTTP server with ingress support (UI, file API)
 * - WebSocket server for UI communication
 * - HA WebSocket client
 * - Worker thread lifecycle
 * - AI chat agent and inline completions
 * - MCP server for external AI clients
 * - File management, storage and logging
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as crypto from "crypto";
import express from "express";
import WebSocket from "ws";
import { HAClient } from "./ha-client";
import { Storage } from "./storage";
import { Logger } from "./logging";
import { WorkerManager } from "./worker-manager";
import { FileManager } from "./file-manager";
import { AISettings, AIConfig, AIOptions, AUTOMATION_MODEL_SOURCES, AutomationModelSource, PROVIDER_IDS, ProviderId } from "./ai/config";
import { ChatAgent, ApprovalDecision } from "./ai/agent";
import { AIMemory } from "./ai/memory";
import { AutomationAI } from "./ai/automation-ai";
import { findMqttSettings, MqttEntities } from "./mqtt-entities";
import { startTaeEntities } from "./tae-entities";
import { listModels } from "./ai/providers";
import { EFFORT_LEVELS, EffortLevel, ProviderError } from "./ai/types";
import { TypeChecker } from "./tools/type-check";
import { ToolContext, buildEntityRows, getTools } from "./tools";
import { startMcpServer } from "./mcp-server";
import { FileHistory } from "./file-history";
import { TestManager } from "./test-manager";

// ─── Configuration ──────────────────────────────────────────

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN || "";
const HA_TOKEN = SUPERVISOR_TOKEN || process.env.TAE_HA_TOKEN || ""; //< TAE_HA_TOKEN: long-lived token for local development
const DATA_DIR = process.env.TAE_DATA_DIR || "/data";
const INGRESS_PATH = process.env.INGRESS_PATH || "";
const PORT = parseInt(process.env.INGRESS_PORT || "3200", 10);
const MCP_PORT = parseInt(process.env.TAE_MCP_PORT || "3201", 10);
const MCP_PORT_KEY = `${MCP_PORT}/tcp`;
const INGRESS_PROXY_IP = "172.30.32.2";
const RESTRICT_TO_INGRESS = !!SUPERVISOR_TOKEN; //< running as an add-on: only HA ingress may reach the UI
const ALLOWED_UI_CLIENTS = new Set([INGRESS_PROXY_IP, "127.0.0.1", "::1"]);
const MCP_TOKEN_SETTING = "mcp_token";
const MCP_TOKEN_BYTES = 32;
const SUPERVISOR_SELF_INFO_URL = "http://supervisor/addons/self/info";
const SUPERVISOR_TIMEOUT_MS = 10000;
const DEFAULT_LOG_COUNT = 500;
const RECENT_HISTORY_COUNT = 100;
const JSON_BODY_LIMIT = "1mb";
const AUTOMATIONS_PATH = path.join(DATA_DIR, "automations");
const DB_PATH = path.join(DATA_DIR, "tae.db");
const OPTIONS_PATH = path.join(DATA_DIR, "options.json");

let logLevel = "info";
let syncPath = "/share/tae";
let mcpTokenOption = "";
let aiConfigFromOptions: AIOptions = { provider: "none", apiKey: "", model: "", completionModel: "" };

try {
  if (fs.existsSync(OPTIONS_PATH)) {
    const options = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf-8"));
    logLevel = options.log_level || "info";
    syncPath = options.sync_path || "/share/tae";
    mcpTokenOption = (options.mcp_token || "").trim();
    aiConfigFromOptions = {
      provider: PROVIDER_IDS.includes(options.ai_provider) ? options.ai_provider : "none",
      apiKey: options.ai_api_key || "",
      model: options.ai_model || "",
      completionModel: options.ai_completion_model || "",
    };
  }
} catch {}

let appVersion = "dev";
try {
  appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8")).version || appVersion;
} catch {}

// ─── Ensure directories exist ───────────────────────────────

if (!fs.existsSync(AUTOMATIONS_PATH)) {
  fs.mkdirSync(AUTOMATIONS_PATH, { recursive: true });
}

// ─── Initialize subsystems ──────────────────────────────────

const logger = new Logger(logLevel);
const storage = new Storage(DB_PATH);
const fileHistory = new FileHistory(storage.database);
const fileManager = new FileManager(AUTOMATIONS_PATH, syncPath, fileHistory);
const aiSettings = new AISettings(storage, aiConfigFromOptions);
const aiMemory = new AIMemory(storage);
const typeChecker = new TypeChecker(AUTOMATIONS_PATH);

const haClient = new HAClient({
  supervisorToken: HA_TOKEN,
  logFn: (level, source, message, extra) => {
    logger.log(level, source, message, extra);
  },
  onConnect: () => {
    logger.log("info", "main", "Home Assistant connected");
    workerManager.onHaConnected();
  },
});

const workerManager = new WorkerManager(haClient, storage, logger, {
  automationsPath: AUTOMATIONS_PATH,
  logLevel,
});

const testManager = new TestManager(haClient, storage, logger, {
  automationsPath: AUTOMATIONS_PATH,
  logLevel,
});

const automationAI = new AutomationAI(aiSettings, logger);
workerManager.setAIGenerator((request) => automationAI.generate(request));
testManager.setAIGenerator((request) => automationAI.generate(request));

// Entities in HA over MQTT: automations' this.sensor()/binarySensor() and TAE's own status and switches
const mqttEntities = new MqttEntities(logger, appVersion);

async function startMqtt(): Promise<void> {
  const settings = await findMqttSettings(SUPERVISOR_TOKEN);
  if (!settings) {
    logger.log("info", "mqtt", "No MQTT broker (install the Mosquitto broker app to publish entities to HA)");
    return;
  }
  mqttEntities.connect(settings);
  workerManager.setEntityPublisher(mqttEntities);
  startTaeEntities(mqttEntities, workerManager, logger, appVersion);
}

function loadSkillMarkdown(): string {
  // In Docker: /app/SKILL.md; in dev: project root
  const candidates = [path.join(__dirname, "..", "..", "SKILL.md"), path.join(__dirname, "..", "..", "..", "SKILL.md")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
  }
  logger.log("warn", "main", "SKILL.md not found");
  return "";
}
const skillMarkdown = loadSkillMarkdown();

// ─── Default automation template ────────────────────────────

const defaultIndexPath = path.join(AUTOMATIONS_PATH, "index.ts");
if (!fs.existsSync(defaultIndexPath)) {
  const defaultsSource = path.join(__dirname, "..", "..", "defaults", "automations", "index.ts");
  if (fs.existsSync(defaultsSource)) {
    fs.copyFileSync(defaultsSource, defaultIndexPath);
    logger.log("info", "main", "Created default automations/index.ts");
  } else {
    // Create minimal template inline
    fs.writeFileSync(
      defaultIndexPath,
      `import { Automation, registerAutomation, startAutomation } from 'tae';

class HelloWorldAutomation extends Automation {
  async onStart() {
    this.log('Hello from TAE! Automation is running.');
  }

  async onStop() {
    this.log('Automation stopped.');
  }
}

export function onInit() {
  const hello = new HelloWorldAutomation();
  registerAutomation(hello);
  startAutomation(hello);
}
`,
      "utf-8"
    );
    logger.log("info", "main", "Created default automations/index.ts (inline template)");
  }
}

// ─── Install type definitions for editor ────────────────────

function installTypeDefinitions(): void {
  const taeTypesDir = path.join(AUTOMATIONS_PATH, "node_modules", "tae");
  const apiDir = path.join(__dirname, "..", "api");

  if (!fs.existsSync(taeTypesDir)) {
    fs.mkdirSync(taeTypesDir, { recursive: true });
  }

  // Copy .d.ts and .js files from compiled api/
  const apiFiles = fs.readdirSync(apiDir);
  for (const file of apiFiles) {
    if (file.endsWith(".d.ts") || file.endsWith(".js") || file.endsWith(".d.ts.map")) {
      fs.copyFileSync(path.join(apiDir, file), path.join(taeTypesDir, file));
    }
  }

  // Create package.json for the tae module
  fs.writeFileSync(
    path.join(taeTypesDir, "package.json"),
    JSON.stringify(
      {
        name: "tae",
        version: "1.0.0",
        main: "./index.js",
        types: "./index.d.ts",
      },
      null,
      2
    ),
    "utf-8"
  );

  // Create tsconfig.json for automations
  const tsconfigPath = path.join(AUTOMATIONS_PATH, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "commonjs",
            lib: ["ES2022"],
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            resolveJsonModule: true,
            baseUrl: ".",
            outDir: "./dist",
          },
          include: ["./**/*.ts"],
          exclude: ["node_modules", "dist"],
        },
        null,
        2
      ),
      "utf-8"
    );
  }
}

try {
  installTypeDefinitions();
  logger.log("info", "main", "Type definitions installed for automations");
} catch (err: any) {
  logger.log("warn", "main", `Failed to install type definitions: ${err.message}`);
}

// ─── MCP token ──────────────────────────────────────────────

function currentMcpToken(): string {
  return mcpTokenOption || storage.getSetting<string>(MCP_TOKEN_SETTING) || "";
}

function generateMcpToken(): string {
  const token = crypto.randomBytes(MCP_TOKEN_BYTES).toString("base64url");
  storage.setSetting(MCP_TOKEN_SETTING, token);
  return token;
}

if (!currentMcpToken()) {
  generateMcpToken();
}

/** Host port the Supervisor maps to the MCP port (null when disabled in the add-on's Network settings). */
let mcpHostPort: number | null = null;

async function loadMcpHostPort(): Promise<void> {
  if (!SUPERVISOR_TOKEN) {
    mcpHostPort = MCP_PORT;
    return;
  }
  try {
    const res = await fetch(SUPERVISOR_SELF_INFO_URL, {
      headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
      signal: AbortSignal.timeout(SUPERVISOR_TIMEOUT_MS),
    });
    const info = (await res.json()) as any;
    const mapped = info?.data?.network?.[MCP_PORT_KEY];
    mcpHostPort = typeof mapped === "number" ? mapped : null;
  } catch (err: any) {
    logger.log("debug", "main", `Could not read add-on network info: ${err.message}`);
  }
}

// ─── WebSocket broadcast helpers ────────────────────────────

const wss = new WebSocket.Server({ noServer: true });

function broadcast(message: unknown): void {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── Tools, AI agent, MCP ───────────────────────────────────

function broadcastTests(): void {
  broadcast({ type: "tests", data: testManager.list() });
}

const toolContext: ToolContext = {
  haClient,
  workerManager,
  fileManager,
  logger,
  typeChecker,
  testManager,
  fileHistory,
  memory: aiMemory,
  changeSource: "editor",
  getSkillMarkdown: () => skillMarkdown,
  notifyFileChanged: (relativePath, content) => {
    broadcast({ type: "file_changed", path: relativePath, content: content ?? null, deleted: content === undefined });
    broadcast({ type: "files", data: fileManager.listFiles() });
  },
  notifyTestsChanged: broadcastTests,
};

const chatAgent = new ChatAgent(aiSettings, { ...toolContext, changeSource: "ai-chat" }, logger, storage, aiMemory);
aiMemory.onChange(() => broadcast({ type: "ai_memory", data: aiMemory.state() }));

workerManager.onReloaded(() => broadcast({ type: "reload_ack", success: true }));

workerManager.onTimeline((timeline, trace) => {
  broadcast({
    type: "trace_update",
    automationId: timeline.automationId,
    trace,
    ignoredCount: timeline.ignoredCount,
    lastIgnoredAt: timeline.lastIgnoredAt,
  });
});

testManager.onRun((event) => {
  if (event.type === "started") broadcast({ type: "test_started", scenarioId: event.scenarioId });
  else broadcast({ type: "test_result", scenarioId: event.scenarioId, result: event.result });
});

const mcpServer = startMcpServer({
  port: MCP_PORT,
  getToken: currentMcpToken,
  tools: getTools(),
  ctx: { ...toolContext, changeSource: "mcp" },
  logger,
  version: appVersion,
});

// ─── Express + WebSocket Server ─────────────────────────────

function isAllowedUiClient(address: string | undefined): boolean {
  if (!RESTRICT_TO_INGRESS) return true;
  return ALLOWED_UI_CLIENTS.has((address || "").replace(/^::ffff:/, ""));
}

const app = express();
app.use((req, res, next) => {
  if (isAllowedUiClient(req.socket.remoteAddress)) {
    next();
    return;
  }
  res.status(403).send("TAE only accepts connections through Home Assistant ingress");
});
app.use(express.json({ limit: JSON_BODY_LIMIT }));

const server = http.createServer(app);

// Serve the UI HTML
const uiHtmlPath = path.join(__dirname, "ui", "index.html");
const uiHtmlPathAlt = path.join(__dirname, "..", "src", "main", "ui", "index.html");

app.get(`${INGRESS_PATH}/`, (_req, res) => {
  const htmlPath = fs.existsSync(uiHtmlPath) ? uiHtmlPath : uiHtmlPathAlt;
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send("UI not found");
  }
});

// ─── API Routes ─────────────────────────────────────────────

function wildcardPath(req: express.Request): string {
  const segments = (req.params as Record<string, string | string[]>).filePath;
  return Array.isArray(segments) ? segments.join("/") : String(segments || "");
}

// Health check
app.get(`${INGRESS_PATH}/api/health`, (_req, res) => {
  res.json({
    status: "ok",
    connected: haClient.isConnected(),
    uptime: process.uptime(),
    automations: workerManager.getAutomations().length,
  });
});

// File operations for editor
app.get(`${INGRESS_PATH}/api/files`, (_req, res) => {
  try {
    res.json(fileManager.listFiles());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get(`${INGRESS_PATH}/api/files/*filePath`, (req, res) => {
  try {
    const filePath = wildcardPath(req);
    const content = fileManager.readFile(filePath);
    res.json({ path: filePath, content });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.put(`${INGRESS_PATH}/api/files/*filePath`, (req, res) => {
  try {
    const filePath = wildcardPath(req);
    const { content } = req.body ?? {};
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    fileManager.writeFile(filePath, content);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${INGRESS_PATH}/api/files`, (req, res) => {
  try {
    const { path: filePath, content, isDirectory } = req.body ?? {};
    if (!filePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (isDirectory) {
      fileManager.createDirectory(filePath);
    } else {
      fileManager.createFile(filePath, content || "");
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete(`${INGRESS_PATH}/api/files/*filePath`, (req, res) => {
  try {
    fileManager.deleteFile(wildcardPath(req));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${INGRESS_PATH}/api/files/rename`, (req, res) => {
  try {
    const { oldPath, newPath } = req.body ?? {};
    fileManager.renameFile(oldPath, newPath);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Sync operations
app.post(`${INGRESS_PATH}/api/sync/export`, (_req, res) => {
  try {
    res.json(fileManager.exportToSync());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${INGRESS_PATH}/api/sync/import`, (_req, res) => {
  try {
    res.json(fileManager.importFromSync());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WebSocket handling ─────────────────────────────────────

server.on("upgrade", (request, socket, head) => {
  const url = request.url || "";
  if (!isAllowedUiClient(request.socket.remoteAddress)) {
    socket.destroy();
    return;
  }
  if (url === `${INGRESS_PATH}/ws` || url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

function mcpInfo(): Record<string, unknown> {
  return {
    port: MCP_PORT,
    hostPort: mcpHostPort,
    path: "/mcp",
    token: currentMcpToken(),
    tokenFromOptions: !!mcpTokenOption,
  };
}

wss.on("connection", (ws) => {
  logger.log("debug", "ws", "UI client connected");
  const chatSessions = new Set<string>(); //< chats started from this connection
  let completionAbort: AbortController | null = null;

  const sendJson = (message: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  // Send server config (sync path, etc.) so the UI can show accurate paths.
  sendJson({ type: "server_config", data: { syncPath, automationsPath: AUTOMATIONS_PATH, version: appVersion } });

  // Forward logs
  const unsubLog = logger.onLog((entry) => {
    sendJson({ type: "log_entry", data: entry });
  });

  // Forward automation state changes
  const unsubAutomations = workerManager.onAutomationsChanged((automations) => {
    sendJson({ type: "automations", data: automations });
  });

  ws.on("message", async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case "get_automations":
          sendJson({ type: "automations", data: workerManager.getAutomations() });
          break;

        case "get_logs":
          sendJson({ type: "logs", data: logger.getLogs(msg.count || DEFAULT_LOG_COUNT) });
          break;

        case "clear_logs":
          logger.clearLogs();
          break;

        case "start_automation":
          if (msg.automationId) {
            await workerManager.startAutomation(msg.automationId);
          }
          break;

        case "stop_automation":
          if (msg.automationId) {
            await workerManager.stopAutomation(msg.automationId);
          }
          break;

        case "reload":
          logger.log("info", "main", "Reload requested from UI");
          try {
            await workerManager.reload(); //< success is broadcast by onReloaded
          } catch (err: any) {
            sendJson({ type: "reload_ack", success: false, error: err.message });
          }
          break;

        case "get_files":
          sendJson({ type: "files", data: fileManager.listFiles() });
          break;

        case "get_all_file_contents":
          try {
            sendJson({ type: "all_file_contents", data: fileManager.readAllTsContents() });
          } catch (err: any) {
            sendJson({ type: "error", message: `Read all files error: ${err.message}` });
          }
          break;

        case "read_file":
          try {
            sendJson({ type: "file_content", path: msg.path, content: fileManager.readFile(msg.path) });
          } catch (err: any) {
            sendJson({ type: "error", message: `File read error: ${err.message}` });
          }
          break;

        case "write_file":
          try {
            fileManager.writeFile(msg.path, msg.content);
            sendJson({ type: "file_saved", path: msg.path });
          } catch (err: any) {
            sendJson({ type: "error", message: `File write error: ${err.message}` });
          }
          break;

        case "create_file":
          try {
            if (msg.isDirectory) {
              fileManager.createDirectory(msg.path);
            } else {
              fileManager.createFile(msg.path, msg.content || "");
            }
            sendJson({ type: "file_created", path: msg.path });
          } catch (err: any) {
            sendJson({ type: "error", message: `Create error: ${err.message}` });
          }
          break;

        case "delete_file":
          try {
            fileManager.deleteFile(msg.path);
            sendJson({ type: "file_deleted", path: msg.path });
          } catch (err: any) {
            sendJson({ type: "error", message: `Delete error: ${err.message}` });
          }
          break;

        case "rename_file":
          try {
            fileManager.renameFile(msg.oldPath, msg.newPath);
            sendJson({ type: "file_renamed", oldPath: msg.oldPath, newPath: msg.newPath });
            broadcast({ type: "files", data: fileManager.listFiles() });
          } catch (err: any) {
            sendJson({ type: "error", message: `Rename error: ${err.message}` });
          }
          break;

        case "export_sync":
          try {
            sendJson({ type: "sync_result", action: "export", ...fileManager.exportToSync() });
          } catch (err: any) {
            sendJson({ type: "error", message: `Export error: ${err.message}` });
          }
          break;

        case "import_sync":
          try {
            sendJson({ type: "sync_result", action: "import", ...fileManager.importFromSync() });
          } catch (err: any) {
            sendJson({ type: "error", message: `Import error: ${err.message}` });
          }
          break;

        case "get_all_entities":
          sendJson({ type: "all_entities", data: haClient.getAllStates() });
          break;

        case "get_entity":
          sendJson({ type: "entity_state", requestId: msg.requestId, entityId: msg.entityId, state: haClient.getEntityState(String(msg.entityId || "")) ?? null });
          break;

        case "get_device_registry":
          try {
            const registries = await haClient.getRegistries();
            sendJson({
              type: "device_registry",
              data: { devices: registries.devices, entityRegistry: registries.entities, areas: registries.areas },
            });
          } catch (err: any) {
            sendJson({ type: "error", message: `Device registry error: ${err.message}` });
          }
          break;

        case "get_storage":
          sendJson({ type: "storage_data", persistent: storage.getAllPersistent(), temp: storage.getAllTemp() });
          break;

        case "set_storage":
          try {
            const { namespace: ns, key: sKey, value: sVal, persistent: isPersistent } = msg;
            if (!ns || !sKey) throw new Error("namespace and key are required");
            if (isPersistent) {
              storage.persistentSet(ns, sKey, sVal);
            } else {
              storage.tempSet(ns, sKey, sVal);
            }
            sendJson({ type: "storage_saved", success: true });
          } catch (err: any) {
            sendJson({ type: "error", message: `Storage set error: ${err.message}` });
          }
          break;

        case "exec_command":
          try {
            const cmdResult = await executeTerminalCommand(msg.command, msg.args, haClient, logger);
            sendJson({ type: "exec_result", id: msg.id, success: true, result: cmdResult });
          } catch (err: any) {
            sendJson({ type: "exec_result", id: msg.id, success: false, error: err.message });
          }
          break;

        case "get_skill_file":
          sendJson({ type: "skill_file", data: skillMarkdown });
          break;

        // ─── Editor entity help ─────────────────────────────

        case "get_entity_index":
          try {
            const rows = await buildEntityRows(toolContext);
            let services: string[] = [];
            try {
              const all = await haClient.getServices();
              services = Object.entries(all).flatMap(([domain, domainServices]) =>
                Object.keys(domainServices as object).map((service) => `${domain}.${service}`)
              );
            } catch {}
            sendJson({ type: "entity_index", entities: rows, services });
          } catch (err: any) {
            sendJson({ type: "error", message: `Entity index error: ${err.message}` });
          }
          break;

        // ─── Timeline ───────────────────────────────────────

        case "get_traces":
          sendJson({ type: "traces", data: workerManager.getTimelines() });
          break;

        // ─── Tests ──────────────────────────────────────────

        case "test_list":
          sendJson({ type: "tests", data: testManager.list() });
          break;

        case "test_save":
          try {
            const scenario = testManager.save(msg.scenario);
            sendJson({ type: "test_saved", scenario, requestId: msg.requestId });
            broadcastTests();
          } catch (err: any) {
            sendJson({ type: "test_error", requestId: msg.requestId, message: `Could not save the test: ${err.message}` });
          }
          break;

        case "test_delete":
          if (msg.id) {
            testManager.delete(String(msg.id));
            broadcastTests();
          }
          break;

        case "test_run":
          try {
            await testManager.run(String(msg.id || ""));
            broadcastTests();
          } catch (err: any) {
            sendJson({ type: "test_error", message: `Could not run the test: ${err.message}` });
          }
          break;

        case "test_stop":
          testManager.stop(String(msg.id || ""));
          break;

        // ─── File history ───────────────────────────────────

        case "history_list":
          sendJson({
            type: "file_history",
            path: msg.path || null,
            versions: msg.path ? fileHistory.list(String(msg.path)) : fileHistory.recent(RECENT_HISTORY_COUNT),
          });
          break;

        case "history_get": {
          const version = fileHistory.get(Number(msg.id));
          if (!version) {
            sendJson({ type: "error", message: `No file version ${msg.id}` });
            break;
          }
          const previous = fileHistory.previous(version.id);
          sendJson({ type: "file_version", version, previous: previous ? { id: previous.id, content: previous.content } : null });
          break;
        }

        case "history_restore": {
          const version = fileHistory.get(Number(msg.id));
          if (!version || version.content === null) {
            sendJson({ type: "error", message: `File version ${msg.id} cannot be restored` });
            break;
          }
          fileManager.writeFile(version.path, version.content, "restore");
          toolContext.notifyFileChanged(version.path, version.content);
          logger.log("info", "main", `Restored ${version.path} to version ${version.id}`);
          sendJson({ type: "history_restored", path: version.path, id: version.id });
          break;
        }

        case "get_snippets":
          try {
            sendJson({ type: "snippets", data: fileManager.readAllSnippets() });
          } catch (err: any) {
            sendJson({ type: "error", message: `Snippets error: ${err.message}` });
          }
          break;

        // ─── AI ─────────────────────────────────────────────

        case "ai_get_config":
          sendJson({ type: "ai_config", data: aiSettings.info() });
          break;

        // ─── AI memory ──────────────────────────────────────

        case "ai_memory_get":
          sendJson({ type: "ai_memory", data: aiMemory.state() });
          break;

        case "ai_memory_add":
        case "ai_memory_update":
        case "ai_memory_delete":
          try {
            if (msg.type === "ai_memory_add") aiMemory.add(String(msg.text ?? ""), "user");
            else if (msg.type === "ai_memory_update") aiMemory.update(Number(msg.id), String(msg.text ?? ""), "user");
            else aiMemory.delete(Number(msg.id));
          } catch (err: any) {
            sendJson({ type: "ai_memory_error", message: err.message, id: msg.id ?? null });
            sendJson({ type: "ai_memory", data: aiMemory.state() });
          }
          break;

        case "ai_memory_settings":
          aiMemory.updateSettings(msg.settings || {});
          break;

        case "ai_chats_delete_all":
          chatAgent.deleteAllChats();
          logger.log("info", "ai", "All saved chats deleted");
          aiMemory.notifyChanged();
          break;

        case "ai_set_config":
          try {
            const change: Partial<AIConfig> = {};
            if (msg.provider !== undefined) {
              if (!PROVIDER_IDS.includes(msg.provider)) throw new Error(`Unknown provider ${msg.provider}`);
              change.provider = msg.provider as ProviderId;
            }
            if (typeof msg.apiKey === "string" && msg.apiKey.trim()) change.apiKey = msg.apiKey.trim();
            if (typeof msg.model === "string") change.model = msg.model.trim();
            if (typeof msg.completionModel === "string") change.completionModel = msg.completionModel.trim();
            if (msg.automationModelSource !== undefined) {
              if (!AUTOMATION_MODEL_SOURCES.includes(msg.automationModelSource)) throw new Error(`Unknown automation model source ${msg.automationModelSource}`);
              change.automationModelSource = msg.automationModelSource as AutomationModelSource;
            }
            if (typeof msg.automationModel === "string") change.automationModel = msg.automationModel.trim();
            for (const field of ["chatEffort", "completionEffort"] as const) {
              if (msg[field] === undefined) continue;
              if (!EFFORT_LEVELS.includes(msg[field])) throw new Error(`Unknown effort level ${msg[field]}`);
              change[field] = msg[field] as EffortLevel;
            }
            aiSettings.update(change);
            logger.log("info", "ai", `AI settings saved (provider: ${aiSettings.get().provider})`);
            broadcast({ type: "ai_config", data: aiSettings.info() });
          } catch (err: any) {
            sendJson({ type: "error", message: `AI config error: ${err.message}` });
          }
          break;

        case "ai_list_models":
          try {
            const provider: ProviderId = PROVIDER_IDS.includes(msg.provider) ? msg.provider : aiSettings.get().provider;
            const stored = aiSettings.get();
            const apiKey = (typeof msg.apiKey === "string" && msg.apiKey.trim()) || (stored.provider === provider ? stored.apiKey : "");
            const models = await listModels(provider, apiKey);
            sendJson({ type: "ai_models", provider, models });
          } catch (err: any) {
            const message = err instanceof ProviderError ? err.message : `Could not list models: ${err.message}`;
            sendJson({ type: "ai_models", provider: msg.provider, models: [], error: message });
          }
          break;

        case "ai_complete": {
          completionAbort?.abort(); //< only the latest keystroke matters
          const controller = new AbortController();
          completionAbort = controller;
          try {
            const text = await chatAgent.complete(
              {
                prefix: msg.prefix || "",
                suffix: msg.suffix || "",
                filePath: msg.filePath || "",
                otherFiles: msg.otherFiles,
                entityContext: msg.entityContext,
              },
              controller.signal
            );
            sendJson({ type: "ai_completion", id: msg.id, text });
          } catch (err: any) {
            sendJson({ type: "ai_completion", id: msg.id, text: "", error: err.message });
          } finally {
            if (completionAbort === controller) completionAbort = null;
          }
          break;
        }

        case "ai_chat_send": {
          const sessionId = String(msg.sessionId || "");
          if (!sessionId || typeof msg.text !== "string") break;
          chatSessions.add(sessionId);
          await chatAgent.send(
            sessionId,
            msg.text,
            msg.context,
            (event) => sendJson({ type: "ai_event", sessionId, event }),
            { priorMessages: Number(msg.priorMessages) || 0 }
          );
          break;
        }

        case "ai_chat_cancel":
          if (msg.sessionId) chatAgent.cancel(String(msg.sessionId));
          break;

        case "ai_chat_reset":
          if (msg.sessionId) chatAgent.reset(String(msg.sessionId));
          break;

        case "ai_tool_decision": {
          const decision: ApprovalDecision = ["allow", "deny", "always"].includes(msg.decision) ? msg.decision : "deny";
          chatAgent.decide(String(msg.sessionId || ""), String(msg.toolUseId || ""), decision);
          break;
        }

        case "mcp_get_info":
          await loadMcpHostPort();
          sendJson({ type: "mcp_info", data: mcpInfo() });
          break;

        case "mcp_regenerate_token":
          if (mcpTokenOption) {
            sendJson({ type: "error", message: "The MCP token is set in the add-on configuration (mcp_token); change it there." });
            break;
          }
          generateMcpToken();
          logger.log("info", "mcp", "MCP token regenerated");
          sendJson({ type: "mcp_info", data: mcpInfo() });
          break;
      }
    } catch (err: any) {
      logger.log("error", "ws", `Message handler error: ${err.message}`, err);
    }
  });

  ws.on("close", () => {
    unsubLog();
    unsubAutomations();
    completionAbort?.abort();
    for (const sessionId of chatSessions) {
      chatAgent.cancel(sessionId);
    }
    logger.log("debug", "ws", "UI client disconnected");
  });
});

// ─── Terminal command execution ─────────────────────────────

async function executeTerminalCommand(
  command: string,
  args: any,
  client: HAClient,
  log: Logger
): Promise<any> {
  log.log("info", "ui-terminal", `Executing: ${command}`, args);

  switch (command) {
    case "callService": {
      const { domain, service, data } = args;
      if (!domain || !service) throw new Error("callService requires domain and service");
      let serviceData = data || {};
      let target: { entity_id?: string | string[] } | undefined;
      if (serviceData.entity_id) {
        target = { entity_id: serviceData.entity_id };
        const { entity_id: _eid, ...rest } = serviceData;
        serviceData = rest;
      }
      return client.callService(domain, service, serviceData, target);
    }
    case "getEntityState": {
      const { entityId } = args;
      if (!entityId) throw new Error("getEntityState requires entityId");
      const state = client.getEntityState(entityId);
      if (!state) return { error: `Entity not found: ${entityId}` };
      return state;
    }
    case "fetchEntityState": {
      const { entityId } = args;
      if (!entityId) throw new Error("fetchEntityState requires entityId");
      const state = await client.fetchEntityState(entityId);
      if (!state) return { error: `Entity not found: ${entityId}` };
      return state;
    }
    case "getAllEntities": {
      return client.getAllStates().map((state) => ({
        entity_id: state.entity_id,
        state: state.state,
        friendly_name: state.attributes?.friendly_name || "",
      }));
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ─── Start server ───────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  TypeScript Automation Engine — Starting...      ║");
  console.log("╚══════════════════════════════════════════════════╝");
  logger.log("info", "main", `TAE ${appVersion}, Node ${process.version}`);
  logger.log("info", "main", `Log level: ${logLevel}`);
  logger.log("info", "main", `Ingress path: ${INGRESS_PATH || "(none)"}`);
  logger.log("info", "main", `Automations path: ${AUTOMATIONS_PATH}`);
  logger.log("info", "main", `Sync path: ${syncPath}`);
  logger.log(
    "info",
    "main",
    `Supervisor token: ${SUPERVISOR_TOKEN ? `present (${SUPERVISOR_TOKEN.length} chars)` : "MISSING"}`
  );

  if (!SUPERVISOR_TOKEN) {
    logger.log(
      "error",
      "main",
      "No SUPERVISOR_TOKEN found. Ensure homeassistant_api: true in config.yaml"
    );
  }

  server.listen(PORT, "0.0.0.0", () => {
    logger.log("info", "main", `Server listening on port ${PORT}${RESTRICT_TO_INGRESS ? " (ingress only)" : ""}`);
  });
  loadMcpHostPort().catch(() => {});
  startMqtt().catch((err) => logger.log("warn", "mqtt", `MQTT setup failed: ${err?.message ?? err}`));

  // Connect to Home Assistant
  try {
    await haClient.connect();
  } catch (err: any) {
    logger.log("error", "main", `Failed to connect to HA: ${err.message}`, err);
    logger.log("info", "main", "Will retry automatically...");
  }
}

// ─── Graceful shutdown ──────────────────────────────────────

async function shutdown(signalName: string): Promise<void> {
  logger.log("info", "main", `${signalName} received, shutting down...`);
  await workerManager.terminateWorker("stop");
  await mqttEntities.disconnect().catch(() => {});
  storage.close();
  server.close();
  mcpServer.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

main();
