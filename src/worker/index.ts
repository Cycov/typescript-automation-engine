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
 *
 * With `workerData.test` it instead runs one test scenario in isolation:
 * simulated states and clock; service calls reach Home Assistant only with live calls.
 */

import { workerData } from "worker_threads";
import * as path from "path";
import * as fs from "fs";
import { Bridge, WorkerHost } from "./bridge";
import { AutomationManager } from "./automation-manager";
import { TestHost } from "./test-host";
import { runTestScenario } from "./test-runner";
import { WorkerConfig, WorkerData } from "../shared/messages";

const data: WorkerData | undefined = workerData;
const config: WorkerConfig | undefined = data?.config;
const testSpec = data?.test;

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
const TEST_AI_BRIDGE_SLACK_MS = 5000;
const testHost = testSpec
  ? new TestHost(data?.states ?? [], {
      startTimeMs: testSpec.startTimeMs,
      applyEffects: testSpec.scenario.applyEffects,
      storage: testSpec.storage,
      liveCaller: testSpec.liveCalls ? (args) => bridge.request("callService", args) : undefined,
      liveAI: testSpec.liveCalls ? (args) => bridge.request("aiGenerate", args, args.options.timeoutMs + TEST_AI_BRIDGE_SLACK_MS) : undefined,
    })
  : null;
const host: WorkerHost = testHost ?? bridge;
const manager = new AutomationManager(host, data?.states ?? []);

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

bridge.onShutdown(async (reason) => {
  bridge.sendLog("info", "worker", `Shutdown requested (${reason}), stopping all automations...`);
  try {
    await manager.unloadAll(reason);
  } catch (e: any) {
    bridge.sendLog("error", "worker", `Shutdown error: ${e.message}`);
  }
  process.exit(0);
});

// ─── Catch unhandled errors ─────────────────────────────────

process.on("uncaughtException", (err) => {
  host.sendError(`Uncaught exception: ${err.message}`, err.stack);
});

process.on("unhandledRejection", (reason: any) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  host.sendError(`Unhandled rejection: ${message}`, stack);
});

// ─── Load automations ───────────────────────────────────────

/** Load index.ts and run onInit(). Returns an error message on failure. */
async function loadAutomations(): Promise<string | undefined> {
  const indexPath = path.join(automationsPath, "index.ts");

  if (!fs.existsSync(indexPath)) {
    host.sendLog("warn", "worker", `No automations found at ${indexPath}`);
    return `No automations found at ${indexPath}`;
  }

  host.sendLog("info", "worker", `Loading automations from ${indexPath}`);

  try {
    const automationModule = require(indexPath);

    if (typeof automationModule.onInit === "function") {
      await automationModule.onInit();
    } else {
      host.sendLog("warn", "worker", "automations/index.ts does not export onInit()");
    }
    return undefined;
  } catch (e: any) {
    host.sendError(`Failed to load automations: ${e.message}`, e.stack);
    return `Failed to load automations: ${e.message}`;
  }
}

/**
 * A TAE restart inside a test: stop and unload every automation, then forget the
 * workspace modules (its own copy of the tae module included, which numbers the
 * automation ids), so the next load starts from scratch like a new worker.
 */
async function unloadAutomations(): Promise<void> {
  await manager.unloadAll("stop");
  const workspace = path.resolve(automationsPath) + path.sep;
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(workspace)) delete require.cache[cached];
  }
}

async function runLive(): Promise<void> {
  manager.enableTracing();
  bridge.sendReady();
  await loadAutomations();
  bridge.sendInitComplete(manager.getAutomations());
}

async function runTest(): Promise<void> {
  if (!testSpec || !testHost) return;
  const startedAt = Date.now();
  manager.setStartFilter(testSpec.scenario.automations);
  try {
    const result = await runTestScenario({ spec: testSpec, host: testHost, manager, loadAutomations, unloadAutomations });
    bridge.post({ type: "testResult", result: { ...result, ranAt: new Date(startedAt).toISOString(), realMs: Date.now() - startedAt } });
  } catch (e: any) {
    bridge.post({
      type: "testResult",
      result: {
        scenarioId: testSpec.scenario.id,
        name: testSpec.scenario.name,
        passed: false,
        error: `Test run failed: ${e.message}`,
        ranAt: new Date(startedAt).toISOString(),
        realMs: Date.now() - startedAt,
        simulatedMs: 0,
        items: testHost.items,
        expectations: [],
        serviceCalls: testHost.calls.length,
        automations: [],
      },
    });
  }
}

// ─── Start ──────────────────────────────────────────────────

if (testSpec) {
  runTest();
} else {
  runLive();
}
