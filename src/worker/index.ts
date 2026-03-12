/**
 * Worker Thread Entry Point
 *
 * This runs inside a dedicated Worker Thread. It:
 * 1. Sets up the communication bridge to main process
 * 2. Creates the automation manager
 * 3. Registers the manager globally for the tae API module
 * 4. Configures ts-node for TypeScript execution
 * 5. Loads and runs automations/index.ts
 * 6. Handles shutdown signals
 */

import { workerData } from "worker_threads";
import * as path from "path";
import * as fs from "fs";
import { Bridge } from "./bridge";
import { AutomationManager } from "./automation-manager";
import { WorkerConfig } from "../shared/messages";

const config: WorkerConfig = workerData?.config;

// ─── Security: Block child_process ──────────────────────────

const Module = require("module");
const originalResolveFilename = Module._resolveFilename;
const BLOCKED_MODULES = new Set(["child_process", "child_process/promises"]);

Module._resolveFilename = function (request: string, parent: any, ...rest: any[]) {
  if (BLOCKED_MODULES.has(request)) {
    throw new Error(`Module "${request}" is blocked in automation context for security reasons`);
  }
  return originalResolveFilename.call(this, request, parent, ...rest);
};

// ─── Initialize bridge and manager ──────────────────────────

const bridge = new Bridge();
const manager = new AutomationManager(bridge);

// Make manager available globally for the tae API module
(global as any).__tae_automation_manager = manager;

// ─── Register ts-node for TypeScript execution ──────────────

const automationsPath = config?.automationsPath || "/data/automations";

require("ts-node").register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    target: "ES2022",
    module: "commonjs",
    lib: ["ES2022"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
  },
});

// ─── Handle commands from main ──────────────────────────────

bridge.onCommand("stopAutomation", async (automationId: string) => {
  try {
    await manager.stopById(automationId);
  } catch (e: any) {
    bridge.sendLog("error", automationId, `Stop failed: ${e.message}`);
  }
});

bridge.onCommand("startAutomation", async (automationId: string) => {
  try {
    await manager.startById(automationId);
  } catch (e: any) {
    bridge.sendLog("error", automationId, `Start failed: ${e.message}`);
  }
});

// ─── Handle shutdown ────────────────────────────────────────

bridge.onShutdown(async () => {
  bridge.sendLog("info", "worker", "Shutdown requested, stopping all automations...");
  try {
    await manager.unloadAll();
  } catch (e: any) {
    bridge.sendLog("error", "worker", `Shutdown error: ${e.message}`);
  }
  process.exit(0);
});

// ─── Catch unhandled errors ─────────────────────────────────

process.on("uncaughtException", (err) => {
  bridge.sendError(`Uncaught exception: ${err.message}`, err.stack);
});

process.on("unhandledRejection", (reason: any) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  bridge.sendError(`Unhandled rejection: ${message}`, stack);
});

// ─── Load automations ───────────────────────────────────────

async function loadAutomations(): Promise<void> {
  const indexPath = path.join(automationsPath, "index.ts");

  if (!fs.existsSync(indexPath)) {
    bridge.sendLog("warn", "worker", `No automations found at ${indexPath}`);
    bridge.sendInitComplete([]);
    return;
  }

  bridge.sendLog("info", "worker", `Loading automations from ${indexPath}`);

  try {
    const automationModule = require(indexPath);

    if (typeof automationModule.onInit === "function") {
      await automationModule.onInit();
    } else {
      bridge.sendLog("warn", "worker", "automations/index.ts does not export onInit()");
    }

    bridge.sendInitComplete(manager.getAutomations());
  } catch (e: any) {
    bridge.sendError(`Failed to load automations: ${e.message}`, e.stack);
    bridge.sendInitComplete(manager.getAutomations());
  }
}

// ─── Start ──────────────────────────────────────────────────

bridge.sendReady();
loadAutomations();
