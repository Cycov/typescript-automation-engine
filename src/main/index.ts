/**
 * TypeScript Automation Engine — Main Entry Point
 *
 * Orchestrates:
 * - Express HTTP server with ingress support
 * - WebSocket server for UI communication
 * - HA WebSocket client
 * - Worker thread lifecycle
 * - File management for built-in editor
 * - Storage and logging
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import express from "express";
import WebSocket from "ws";
import { HAClient } from "./ha-client";
import { Storage } from "./storage";
import { Logger } from "./logging";
import { WorkerManager } from "./worker-manager";
import { FileManager } from "./file-manager";

// ─── Configuration ──────────────────────────────────────────

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN || "";
const INGRESS_PATH = process.env.INGRESS_PATH || "";
const PORT = parseInt(process.env.INGRESS_PORT || "3200", 10);

const optionsPath = "/data/options.json";
let logLevel = "info";
let syncPath = "/share/tae";

try {
  if (fs.existsSync(optionsPath)) {
    const options = JSON.parse(fs.readFileSync(optionsPath, "utf-8"));
    logLevel = options.log_level || "info";
    syncPath = options.sync_path || "/share/tae";
  }
} catch {}

const AUTOMATIONS_PATH = "/data/automations";
const DB_PATH = "/data/tae.db";

// ─── Ensure directories exist ───────────────────────────────

if (!fs.existsSync(AUTOMATIONS_PATH)) {
  fs.mkdirSync(AUTOMATIONS_PATH, { recursive: true });
}

// ─── Initialize subsystems ──────────────────────────────────

const logger = new Logger(logLevel);
const storage = new Storage(DB_PATH);
const fileManager = new FileManager(AUTOMATIONS_PATH, syncPath);

const haClient = new HAClient({
  supervisorToken: SUPERVISOR_TOKEN,
  logFn: (level, source, message, extra) => {
    logger.log(level, source, message, extra);
  },
  onConnect: () => {
    logger.log("info", "main", "Home Assistant connected, starting worker...");
    workerManager.start().catch((e) => {
      logger.log("error", "main", `Worker start failed: ${e.message}`);
    });
  },
});

const workerManager = new WorkerManager(haClient, storage, logger, {
  automationsPath: AUTOMATIONS_PATH,
  logLevel,
});

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
} catch (e: any) {
  logger.log("warn", "main", `Failed to install type definitions: ${e.message}`);
}

// ─── Express + WebSocket Server ─────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

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
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get(`${INGRESS_PATH}/api/files/*`, (req: any, res: any) => {
  try {
    const filePath = req.params[0];
    const content = fileManager.readFile(filePath);
    res.json({ path: filePath, content });
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

app.put(`${INGRESS_PATH}/api/files/*`, (req: any, res: any) => {
  try {
    const filePath = req.params[0];
    const { content } = req.body;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    fileManager.writeFile(filePath, content);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${INGRESS_PATH}/api/files`, (req, res) => {
  try {
    const { path: filePath, content, isDirectory } = req.body;
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
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete(`${INGRESS_PATH}/api/files/*`, (req: any, res: any) => {
  try {
    const filePath = req.params[0];
    fileManager.deleteFile(filePath);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${INGRESS_PATH}/api/files/rename`, (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    fileManager.renameFile(oldPath, newPath);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Sync operations
app.post(`${INGRESS_PATH}/api/sync/export`, (_req, res) => {
  try {
    const result = fileManager.exportToSync();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${INGRESS_PATH}/api/sync/import`, (_req, res) => {
  try {
    const result = fileManager.importFromSync();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WebSocket handling ─────────────────────────────────────

server.on("upgrade", (request, socket, head) => {
  const url = request.url || "";
  if (url === `${INGRESS_PATH}/ws` || url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  logger.log("debug", "ws", "UI client connected");

  // Forward logs
  const unsubLog = logger.onLog((entry) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "log_entry", data: entry }));
    }
  });

  // Forward automation state changes
  const unsubAutomations = workerManager.onAutomationsChanged((automations) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "automations", data: automations }));
    }
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
          ws.send(
            JSON.stringify({
              type: "automations",
              data: workerManager.getAutomations(),
            })
          );
          break;

        case "get_logs":
          ws.send(
            JSON.stringify({
              type: "logs",
              data: logger.getLogs(msg.count || 500),
            })
          );
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
            await workerManager.reload();
            ws.send(JSON.stringify({ type: "reload_ack", success: true }));
          } catch (e: any) {
            ws.send(
              JSON.stringify({ type: "reload_ack", success: false, error: e.message })
            );
          }
          break;

        case "get_files":
          ws.send(
            JSON.stringify({
              type: "files",
              data: fileManager.listFiles(),
            })
          );
          break;

        case "get_all_file_contents":
          try {
            const allFiles = fileManager.readAllTsContents();
            ws.send(
              JSON.stringify({
                type: "all_file_contents",
                data: allFiles,
              })
            );
          } catch (e: any) {
            ws.send(
              JSON.stringify({ type: "error", message: `Read all files error: ${e.message}` })
            );
          }
          break;

        case "read_file":
          try {
            const content = fileManager.readFile(msg.path);
            ws.send(
              JSON.stringify({
                type: "file_content",
                path: msg.path,
                content,
              })
            );
          } catch (e: any) {
            ws.send(
              JSON.stringify({ type: "error", message: `File read error: ${e.message}` })
            );
          }
          break;

        case "write_file":
          try {
            fileManager.writeFile(msg.path, msg.content);
            ws.send(JSON.stringify({ type: "file_saved", path: msg.path }));
          } catch (e: any) {
            ws.send(
              JSON.stringify({ type: "error", message: `File write error: ${e.message}` })
            );
          }
          break;

        case "create_file":
          try {
            if (msg.isDirectory) {
              fileManager.createDirectory(msg.path);
            } else {
              fileManager.createFile(msg.path, msg.content || "");
            }
            ws.send(JSON.stringify({ type: "file_created", path: msg.path }));
          } catch (e: any) {
            ws.send(
              JSON.stringify({ type: "error", message: `Create error: ${e.message}` })
            );
          }
          break;

        case "delete_file":
          try {
            fileManager.deleteFile(msg.path);
            ws.send(JSON.stringify({ type: "file_deleted", path: msg.path }));
          } catch (e: any) {
            ws.send(
              JSON.stringify({ type: "error", message: `Delete error: ${e.message}` })
            );
          }
          break;

        case "rename_file":
          try {
            fileManager.renameFile(msg.oldPath, msg.newPath);
            ws.send(JSON.stringify({ type: "file_renamed", oldPath: msg.oldPath, newPath: msg.newPath }));
            // Broadcast updated file tree
            const files = fileManager.listFiles();
            for (const client of wss.clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: "files", data: files }));
              }
            }
          } catch (e: any) {
            ws.send(
              JSON.stringify({ type: "error", message: `Rename error: ${e.message}` })
            );
          }
          break;

        case "export_sync":
          try {
            const result = fileManager.exportToSync();
            ws.send(JSON.stringify({ type: "sync_result", action: "export", ...result }));
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "error", message: `Export error: ${e.message}` }));
          }
          break;

        case "import_sync":
          try {
            const result = fileManager.importFromSync();
            ws.send(JSON.stringify({ type: "sync_result", action: "import", ...result }));
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "error", message: `Import error: ${e.message}` }));
          }
          break;

        case "get_all_entities":
          try {
            const states = haClient.getAllStates();
            ws.send(JSON.stringify({ type: "all_entities", data: states }));
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "error", message: `Entity fetch error: ${e.message}` }));
          }
          break;

        case "get_storage":
          try {
            ws.send(JSON.stringify({
              type: "storage_data",
              persistent: storage.getAllPersistent(),
              temp: storage.getAllTemp(),
            }));
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "error", message: `Storage fetch error: ${e.message}` }));
          }
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
            ws.send(JSON.stringify({ type: "storage_saved", success: true }));
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "error", message: `Storage set error: ${e.message}` }));
          }
          break;

        case "exec_command":
          try {
            const cmdResult = await executeTerminalCommand(msg.command, msg.args, haClient, logger);
            ws.send(JSON.stringify({ type: "exec_result", id: msg.id, success: true, result: cmdResult }));
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "exec_result", id: msg.id, success: false, error: e.message }));
          }
          break;

        case "get_skill_file":
          try {
            // In Docker: /app/SKILL.md; in dev: project root
            let skillPath = path.join(__dirname, "..", "..", "SKILL.md");
            if (!fs.existsSync(skillPath)) {
              skillPath = path.join(__dirname, "..", "..", "..", "SKILL.md");
            }
            const skillContent = fs.existsSync(skillPath)
              ? fs.readFileSync(skillPath, "utf-8")
              : "";
            if (!skillContent) {
              logger.log("warn", "main", `SKILL.md not found at ${skillPath}`);
            }
            ws.send(JSON.stringify({ type: "skill_file", data: skillContent }));
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "error", message: `Skill file error: ${e.message}` }));
          }
          break;
      }
    } catch (e: any) {
      logger.log("error", "ws", `Message handler error: ${e.message}`, e);
    }
  });

  ws.on("close", () => {
    unsubLog();
    unsubAutomations();
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
      const result = await client.callService(domain, service, serviceData, target);
      return result;
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
      const states = client.getAllStates();
      return states.map((s) => ({
        entity_id: s.entity_id,
        state: s.state,
        friendly_name: s.attributes?.friendly_name || "",
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
    logger.log("info", "main", `Server listening on port ${PORT}`);
  });

  // Connect to Home Assistant
  try {
    await haClient.connect();
  } catch (e: any) {
    logger.log("error", "main", `Failed to connect to HA: ${e.message}`, e);
    logger.log("info", "main", "Will retry automatically...");
  }
}

// ─── Graceful shutdown ──────────────────────────────────────

process.on("SIGTERM", async () => {
  logger.log("info", "main", "SIGTERM received, shutting down...");
  await workerManager.terminateWorker();
  storage.close();
  server.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.log("info", "main", "SIGINT received, shutting down...");
  await workerManager.terminateWorker();
  storage.close();
  server.close();
  process.exit(0);
});

main();
