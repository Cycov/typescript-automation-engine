/**
 * Worker Manager — spawns and manages the automation worker thread.
 *
 * Handles:
 * - Worker thread lifecycle (spawn, terminate, reload)
 * - Routing HA API calls from worker to ha-client
 * - Routing storage operations from worker to storage
 * - Forwarding HA events to worker subscriptions
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
} from "../shared/messages";

export class WorkerManager {
  private worker: Worker | null = null;
  private haClient: HAClient;
  private storage: Storage;
  private logger: Logger;
  private automations = new Map<string, AutomationInfo>();
  // subId → { unsubscribe function, automationId }
  private subscriptions = new Map<string, { unsub: () => void; automationId: string }>();
  private automationListeners: ((automations: AutomationInfo[]) => void)[] = [];
  private config: WorkerConfig;
  private initResolve?: () => void;
  private initReject?: (err: Error) => void;

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

  async reload(): Promise<void> {
    this.logger.log("info", "worker-mgr", "Reloading automations...");
    await this.terminateWorker();
    this.automations.clear();
    this.notifyListeners();
    await this.spawnWorker();
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

      this.worker = new Worker(workerPath, {
        workerData: { config: this.config },
      });

      this.worker.on("message", (msg: WorkerToMainMessage) => {
        this.handleWorkerMessage(msg);
      });

      this.worker.on("error", (err) => {
        this.logger.log("error", "worker-mgr", `Worker error: ${err.message}`, {
          stack: err.stack,
        });
        if (this.initReject) {
          this.initReject(err);
          this.initResolve = undefined;
          this.initReject = undefined;
        }
      });

      this.worker.on("exit", (code) => {
        this.logger.log("info", "worker-mgr", `Worker exited with code ${code}`);
        this.worker = null;
        // Clean up all subscriptions
        for (const { unsub } of this.subscriptions.values()) {
          try { unsub(); } catch {}
        }
        this.subscriptions.clear();
      });

      // Send init message
      this.sendToWorker({
        type: "init",
        config: this.config,
      });
    });
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

      case "automationStateChanged":
        const existing = this.automations.get(msg.id);
        if (existing) {
          existing.state = msg.state;
          existing.error = msg.error;
          this.notifyListeners();
        }
        this.logger.log(
          "info",
          "worker-mgr",
          `Automation ${msg.id} → ${msg.state}${msg.error ? ` (${msg.error})` : ""}`
        );
        break;

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

      case "initComplete":
        this.automations.clear();
        for (const a of msg.automations) {
          this.automations.set(a.id, a);
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

      case "error":
        this.logger.log("error", "worker-mgr", `Worker error: ${msg.message}`, {
          stack: msg.stack,
        });
        break;
    }
  }

  private async handleRequest(id: number, method: string, args: any): Promise<void> {
    try {
      let result: any;

      switch (method) {
        case "callService": {
          const { domain, service, data } = args;
          result = await this.haClient.callService(domain, service, data);
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

        case "subscribeStateChange": {
          const { entityId: stateEntityId, subId: stateSubId, automationId: stateAutoId } = args;
          const unsub = this.haClient.onStateChange((data) => {
            if (!stateEntityId || data.entity_id === stateEntityId) {
              this.sendToWorker({
                type: "stateChange",
                subId: stateSubId,
                entityId: data.entity_id,
                oldState: data.old_state,
                newState: data.new_state,
              });
            }
          });
          this.subscriptions.set(stateSubId, { unsub, automationId: stateAutoId });
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
    } catch (e: any) {
      this.sendToWorker({ type: "response", id, error: e.message });
    }
  }

  private sendToWorker(msg: MainToWorkerMessage): void {
    if (this.worker) {
      this.worker.postMessage(msg);
    }
  }

  async terminateWorker(): Promise<void> {
    if (!this.worker) return;

    // Signal shutdown
    this.sendToWorker({ type: "shutdown" });

    // Give worker time to clean up, then force terminate
    const worker = this.worker;
    let exited = false;

    await Promise.race([
      new Promise<void>((resolve) => {
        worker.once("exit", () => {
          exited = true;
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 5000);
      }),
    ]);

    if (!exited && this.worker) {
      this.logger.log("warn", "worker-mgr", "Worker did not exit gracefully, forcing termination");
      await this.worker.terminate();
      this.worker = null;
    }

    // Clean up all subscriptions
    for (const { unsub } of this.subscriptions.values()) {
      try { unsub(); } catch {}
    }
    this.subscriptions.clear();
  }
}
