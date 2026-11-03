/**
 * Worker Manager — spawns and manages the automation worker thread.
 *
 * Handles:
 * - Worker thread lifecycle (spawn, terminate, reload, restart after a crash)
 * - Routing HA API calls from worker to ha-client
 * - Routing storage operations from worker to storage
 * - Forwarding HA state changes and events to the worker
 * - Tracking automation status
 */

import { Worker } from "worker_threads";
import * as path from "path";
import { HAClient } from "./ha-client";
import { Storage } from "./storage";
import { Logger } from "./logging";
import {
  MainToWorkerMessage,
  WorkerToMainMessage,
  AutomationInfo,
  WorkerConfig,
  WorkerData,
  ShutdownReason,
  TraceInfo,
  TraceTrigger,
} from "../shared/messages";

const SHUTDOWN_GRACE_MS = 5000;
const MAX_TRACES_PER_AUTOMATION = 50;
const RESTART_DELAY_MIN_MS = 5000;
const RESTART_DELAY_MAX_MS = 5 * 60 * 1000;
const STABLE_RUN_MS = 10 * 60 * 1000; //< a worker alive this long resets the restart backoff

export interface AutomationTimeline {
  automationId: string;
  traces: TraceInfo[]; //< oldest first
  ignoredCount: number; //< triggers that did nothing (no calls, logs or errors)
  lastIgnoredAt?: number;
  lastIgnoredTrigger?: TraceTrigger;
}

/** Answers this.ai.generate requests from automations. */
export type AIGenerator = (request: { automationId: string; prompt: string; options?: Record<string, any> }) => Promise<string>;

export class WorkerManager {
  private worker: Worker | null = null;
  private haClient: HAClient;
  private storage: Storage;
  private logger: Logger;
  private automations = new Map<string, AutomationInfo>();
  // subId → { unsubscribe function, automationId }
  private subscriptions = new Map<string, { unsub: () => void; automationId: string }>();
  private automationListeners: ((automations: AutomationInfo[]) => void)[] = [];
  private reloadListeners: (() => void)[] = [];
  private timelines = new Map<string, AutomationTimeline>();
  private timelineListeners: ((timeline: AutomationTimeline, trace: TraceInfo | null) => void)[] = [];
  private config: WorkerConfig;
  private initResolve?: () => void;
  private initReject?: (err: Error) => void;
  private unsubStateForward: (() => void) | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartDelayMs = RESTART_DELAY_MIN_MS;
  private aiGenerator?: AIGenerator;
  private spawnedAt = 0;

  constructor(
    haClient: HAClient,
    storage: Storage,
    logger: Logger,
    config: WorkerConfig
  ) {
    this.haClient = haClient;
    this.storage = storage;
    this.logger = logger;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.worker) {
      this.logger.log("debug", "worker-mgr", "Worker already running, skipping start");
      return;
    }
    if (!this.haClient.isConnected()) {
      this.logger.log("warn", "worker-mgr", "HA not connected yet, worker will start when ready");
      return;
    }
    await this.spawnWorker();
  }

  /** Called after an HA reconnect: start the worker, or resync its state copy. */
  onHaConnected(): void {
    if (this.worker) {
      this.sendToWorker({ type: "stateSnapshot", states: this.haClient.getAllStates() });
      return;
    }
    this.start().catch((err) => {
      this.logger.log("error", "worker-mgr", `Worker start failed: ${err.message}`);
    });
  }

  async reload(): Promise<void> {
    this.logger.log("info", "worker-mgr", "Reloading automations...");
    this.cancelRestart();
    await this.terminateWorker("reload");
    this.automations.clear();
    this.notifyListeners();
    await this.spawnWorker();
    for (const listener of this.reloadListeners) {
      try { listener(); } catch {}
    }
  }

  /** Called after every successful reload, whoever triggered it. */
  onReloaded(listener: () => void): void {
    this.reloadListeners.push(listener);
  }

  isRunning(): boolean {
    return this.worker !== null;
  }

  async stopAutomation(automationId: string): Promise<void> {
    this.sendToWorker({ type: "command", command: "stopAutomation", automationId });
  }

  async startAutomation(automationId: string): Promise<void> {
    this.sendToWorker({ type: "command", command: "startAutomation", automationId });
  }

  getAutomations(): AutomationInfo[] {
    return Array.from(this.automations.values());
  }

  onAutomationsChanged(cb: (automations: AutomationInfo[]) => void): () => void {
    this.automationListeners.push(cb);
    return () => {
      const idx = this.automationListeners.indexOf(cb);
      if (idx >= 0) this.automationListeners.splice(idx, 1);
    };
  }

  // ─── Timeline ───────────────────────────────────────────────

  getTimelines(): AutomationTimeline[] {
    return Array.from(this.timelines.values());
  }

  getTimeline(automationId: string): AutomationTimeline | undefined {
    return this.timelines.get(automationId);
  }

  /** Called for every new or updated trace (trace null = only the ignored counter changed). */
  onTimeline(listener: (timeline: AutomationTimeline, trace: TraceInfo | null) => void): () => void {
    this.timelineListeners.push(listener);
    return () => {
      const index = this.timelineListeners.indexOf(listener);
      if (index >= 0) this.timelineListeners.splice(index, 1);
    };
  }

  private timelineFor(automationId: string): AutomationTimeline {
    let timeline = this.timelines.get(automationId);
    if (!timeline) {
      timeline = { automationId, traces: [], ignoredCount: 0 };
      this.timelines.set(automationId, timeline);
    }
    return timeline;
  }

  private storeTrace(trace: TraceInfo): void {
    const timeline = this.timelineFor(trace.automationId);
    const index = timeline.traces.findIndex((existing) => existing.id === trace.id && existing.startedAt === trace.startedAt);
    if (index >= 0) {
      timeline.traces[index] = trace;
    } else {
      timeline.traces.push(trace);
      if (timeline.traces.length > MAX_TRACES_PER_AUTOMATION) timeline.traces.shift();
    }
    this.notifyTimeline(timeline, trace);
  }

  private notifyTimeline(timeline: AutomationTimeline, trace: TraceInfo | null): void {
    for (const listener of this.timelineListeners) {
      try { listener(timeline, trace); } catch {}
    }
  }

  private notifyListeners(): void {
    const list = this.getAutomations();
    for (const cb of this.automationListeners) {
      try { cb(list); } catch {}
    }
  }

  private async spawnWorker(): Promise<void> {
    const workerPath = path.join(__dirname, "..", "worker", "index.js");

    return new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;

      this.logger.log("info", "worker-mgr", `Spawning worker thread: ${workerPath}`);

      const workerData: WorkerData = { config: this.config, states: this.haClient.getAllStates() };
      const worker = new Worker(workerPath, { workerData });
      this.worker = worker;
      this.spawnedAt = Date.now();

      // One forwarder per worker; the worker keeps its own state copy and dispatches locally
      this.unsubStateForward?.();
      this.unsubStateForward = this.haClient.onStateChange((change) => {
        if (this.worker !== worker) return;
        this.sendToWorker({
          type: "stateChanged",
          entityId: change.entity_id,
          oldState: change.old_state,
          newState: change.new_state,
        });
      });

      worker.on("message", (msg: WorkerToMainMessage) => {
        this.handleWorkerMessage(msg);
      });

      worker.on("error", (err) => {
        this.logger.log("error", "worker-mgr", `Worker error: ${err.message}`, {
          stack: err.stack,
        });
        this.failInit(err);
      });

      worker.on("exit", (code) => {
        if (this.worker === worker) {
          this.worker = null;
        }
        this.unsubStateForward?.();
        this.unsubStateForward = null;
        this.cleanupAllSubscriptions();
        if (this.stopping) {
          this.logger.log("info", "worker-mgr", `Worker exited with code ${code}`);
          return;
        }
        this.handleUnexpectedExit(code);
      });

      // Send init message
      this.sendToWorker({
        type: "init",
        config: this.config,
      });
    });
  }

  private failInit(err: Error): void {
    if (this.initReject) {
      this.initReject(err);
      this.initResolve = undefined;
      this.initReject = undefined;
    }
  }

  private handleUnexpectedExit(code: number): void {
    const reason = `Worker exited unexpectedly (code ${code})`;
    this.logger.log("error", "worker-mgr", `${reason} — automations stopped`);
    for (const automation of this.automations.values()) {
      automation.state = "error";
      automation.error = reason;
    }
    this.notifyListeners();
    this.failInit(new Error(reason));
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    if (Date.now() - this.spawnedAt > STABLE_RUN_MS) {
      this.restartDelayMs = RESTART_DELAY_MIN_MS;
    }
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, RESTART_DELAY_MAX_MS);
    this.logger.log("info", "worker-mgr", `Restarting worker in ${Math.round(delay / 1000)}s...`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.automations.clear();
      this.start().catch((err) => {
        this.logger.log("error", "worker-mgr", `Worker restart failed: ${err.message}`);
      });
    }, delay);
  }

  private cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case "request":
        this.handleRequest(msg.id, msg.method, msg.args);
        break;

      case "log":
        this.logger.log(msg.level, msg.automationId || "worker", msg.message, msg.extra);
        break;

      case "automationRegistered":
        this.automations.set(msg.automation.id, msg.automation);
        this.notifyListeners();
        this.logger.log(
          "info",
          "worker-mgr",
          `Automation registered: ${msg.automation.id} (${msg.automation.className})`
        );
        break;

      case "automationStateChanged": {
        const existing = this.automations.get(msg.id);
        if (existing) {
          existing.state = msg.state;
          existing.error = msg.error;
          if (msg.state === "running") {
            existing.lastError = undefined;
            existing.lastErrorAt = undefined;
            existing.errorCount = 0;
          }
          this.notifyListeners();
        }
        this.logger.log(
          "info",
          "worker-mgr",
          `Automation ${msg.id} → ${msg.state}${msg.error ? ` (${msg.error})` : ""}`
        );
        break;
      }

      case "automationError": {
        const existing = this.automations.get(msg.id);
        if (existing) {
          existing.lastError = msg.error;
          existing.lastErrorAt = msg.at;
          existing.errorCount = (existing.errorCount ?? 0) + 1;
          this.notifyListeners();
        }
        break;
      }

      case "automationRemoved":
        this.automations.delete(msg.id);
        // Clean up subscriptions for this automation
        for (const [subId, sub] of this.subscriptions) {
          if (sub.automationId === msg.id) {
            try { sub.unsub(); } catch {}
            this.subscriptions.delete(subId);
          }
        }
        this.notifyListeners();
        break;

      case "ready":
        this.logger.log("info", "worker-mgr", "Worker thread ready");
        break;

      case "initComplete": {
        // Keep error counters from messages that arrived during init
        const previous = new Map(this.automations);
        this.automations.clear();
        for (const automation of msg.automations) {
          const before = previous.get(automation.id);
          this.automations.set(automation.id, {
            ...automation,
            lastError: before?.lastError,
            lastErrorAt: before?.lastErrorAt,
            errorCount: before?.errorCount,
          });
        }
        this.notifyListeners();
        this.logger.log(
          "info",
          "worker-mgr",
          `Init complete: ${msg.automations.length} automation(s) loaded`
        );
        if (this.initResolve) {
          this.initResolve();
          this.initResolve = undefined;
          this.initReject = undefined;
        }
        break;
      }

      case "error":
        this.logger.log("error", "worker-mgr", `Worker error: ${msg.message}`, {
          stack: msg.stack,
        });
        break;

      case "trace":
        this.storeTrace(msg.trace);
        break;

      case "traceIgnored": {
        const timeline = this.timelineFor(msg.automationId);
        timeline.ignoredCount++;
        timeline.lastIgnoredAt = msg.at;
        timeline.lastIgnoredTrigger = msg.trigger;
        this.notifyTimeline(timeline, null);
        break;
      }
    }
  }

  setAIGenerator(generator: AIGenerator): void {
    this.aiGenerator = generator;
  }

  private async handleRequest(id: number, method: string, args: any): Promise<void> {
    try {
      let result: any;

      switch (method) {
        case "callService": {
          const { domain, service, data, returnResponse } = args;
          result = await this.haClient.callService(domain, service, data, undefined, { returnResponse });
          break;
        }

        case "aiGenerate": {
          if (!this.aiGenerator) throw new Error("AI is not available");
          result = await this.aiGenerator(args);
          break;
        }

        case "getEntityState": {
          const { entityId } = args;
          result = this.haClient.getEntityState(entityId);
          break;
        }

        case "fetchEntityState": {
          const { entityId } = args;
          result = await this.haClient.fetchEntityState(entityId);
          break;
        }

        case "subscribeEvent": {
          const { eventType, subId, automationId } = args;
          const unsub = await this.haClient.subscribeToEvent(eventType, (event) => {
            this.sendToWorker({ type: "event", subId, data: event });
          });
          this.subscriptions.set(subId, { unsub, automationId });
          result = true;
          break;
        }

        case "unsubscribe": {
          const { subId: unsubId } = args;
          const sub = this.subscriptions.get(unsubId);
          if (sub) {
            try { sub.unsub(); } catch {}
            this.subscriptions.delete(unsubId);
          }
          result = true;
          break;
        }

        case "unsubscribeAll": {
          const { automationId: cleanupAutoId } = args;
          for (const [subId, sub] of this.subscriptions) {
            if (sub.automationId === cleanupAutoId) {
              try { sub.unsub(); } catch {}
              this.subscriptions.delete(subId);
            }
          }
          result = true;
          break;
        }

        case "storageGet": {
          const { namespace, key, persistent } = args;
          result = persistent
            ? this.storage.persistentGet(namespace, key)
            : this.storage.tempGet(namespace, key);
          break;
        }

        case "storageSet": {
          const { namespace, key, value, persistent } = args;
          if (persistent) {
            this.storage.persistentSet(namespace, key, value);
          } else {
            this.storage.tempSet(namespace, key, value);
          }
          result = true;
          break;
        }

        case "storageDelete": {
          const { namespace, key, persistent } = args;
          if (persistent) {
            this.storage.persistentDelete(namespace, key);
          } else {
            this.storage.tempDelete(namespace, key);
          }
          result = true;
          break;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      this.sendToWorker({ type: "response", id, result });
    } catch (err: any) {
      this.sendToWorker({ type: "response", id, error: err.message });
    }
  }

  private sendToWorker(msg: MainToWorkerMessage): void {
    if (this.worker) {
      this.worker.postMessage(msg);
    }
  }

  private cleanupAllSubscriptions(): void {
    for (const { unsub } of this.subscriptions.values()) {
      try { unsub(); } catch {}
    }
    this.subscriptions.clear();
  }

  async terminateWorker(reason: ShutdownReason = "stop"): Promise<void> {
    if (reason === "stop") {
      this.cancelRestart();
    }
    const worker = this.worker;
    if (!worker) return;

    this.stopping = true;
    try {
      // Give the worker time to clean up, then force terminate
      let exited = false;
      const exitPromise = new Promise<void>((resolve) => {
        worker.once("exit", () => {
          exited = true;
          resolve();
        });
      });
      this.sendToWorker({ type: "shutdown", reason });

      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);

      if (!exited) {
        this.logger.log("warn", "worker-mgr", "Worker did not exit gracefully, forcing termination");
        await worker.terminate();
      }
      if (this.worker === worker) {
        this.worker = null;
      }
      this.cleanupAllSubscriptions();
    } finally {
      this.stopping = false;
    }
  }
}
