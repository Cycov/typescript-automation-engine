/**
 * Automation Manager — manages automation lifecycle inside the worker thread.
 *
 * Responsibilities:
 * - Register, start, stop automations
 * - Track subscriptions per automation
 * - Validate automation state before API calls
 * - Clean up subscriptions on stop
 * - Bridge to main process for HA and storage operations
 */

import { Bridge } from "./bridge";

// Import Automation type — at runtime this is the compiled version
type AutomationInstance = import("../api/automation").Automation;

interface SubscriptionInfo {
  subId: string;
  automationId: string;
  unsub: () => void;
}

let subIdCounter = 0;
function nextSubId(): string {
  return `sub_${++subIdCounter}`;
}

export class AutomationManager {
  private bridge: Bridge;
  private automations = new Map<string, AutomationInstance>();
  private subscriptions = new Map<string, SubscriptionInfo[]>(); // automationId → subs

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  register(automation: AutomationInstance): void {
    if (this.automations.has(automation.id)) {
      throw new Error(`Automation already registered: ${automation.id}`);
    }

    this.automations.set(automation.id, automation);
    this.subscriptions.set(automation.id, []);
    automation.state = "stopped";

    this.bridge.sendAutomationRegistered({
      id: automation.id,
      className: automation.className,
      state: automation.state,
    });
  }

  async start(automation: AutomationInstance): Promise<void> {
    if (!this.automations.has(automation.id)) {
      throw new Error(`Automation not registered: ${automation.id}`);
    }

    if (automation.state === "running") {
      this.bridge.sendLog("warn", automation.id, "Automation already running");
      return;
    }

    try {
      automation.state = "running";
      automation.errorMessage = undefined;
      this.bridge.sendAutomationStateChanged(automation.id, "running");
      await automation.onStart();
    } catch (e: any) {
      automation.state = "error";
      automation.errorMessage = e.message;
      this.bridge.sendAutomationStateChanged(automation.id, "error", e.message);
      this.bridge.sendLog("error", automation.id, `onStart failed: ${e.message}`, { stack: e.stack });
      // Clean up any subscriptions that may have been created before the error
      await this.cleanupSubscriptions(automation.id);
    }
  }

  async stop(automation: AutomationInstance): Promise<void> {
    if (!this.automations.has(automation.id)) {
      throw new Error(`Automation not registered: ${automation.id}`);
    }

    if (automation.state !== "running" && automation.state !== "error") {
      return;
    }

    try {
      await automation.onStop();
    } catch (e: any) {
      this.bridge.sendLog("error", automation.id, `onStop error: ${e.message}`, { stack: e.stack });
    }

    await this.cleanupSubscriptions(automation.id);
    automation.state = "stopped";
    this.bridge.sendAutomationStateChanged(automation.id, "stopped");
  }

  async stopById(automationId: string): Promise<void> {
    const automation = this.automations.get(automationId);
    if (automation) {
      await this.stop(automation);
    }
  }

  async startById(automationId: string): Promise<void> {
    const automation = this.automations.get(automationId);
    if (automation) {
      await this.start(automation);
    }
  }

  async stopAll(): Promise<void> {
    for (const automation of this.automations.values()) {
      if (automation.state === "running") {
        await this.stop(automation);
      }
    }
  }

  async unloadAll(): Promise<void> {
    for (const automation of this.automations.values()) {
      if (automation.state === "running") {
        await this.stop(automation);
      }
      try {
        await automation.onUnload();
      } catch (e: any) {
        this.bridge.sendLog("error", automation.id, `onUnload error: ${e.message}`);
      }
    }
    this.automations.clear();
    this.subscriptions.clear();
  }

  getAutomations(): Array<{ id: string; className: string; state: string }> {
    return Array.from(this.automations.values()).map((a) => ({
      id: a.id,
      className: a.className,
      state: a.state,
    }));
  }

  // ─── HA Client API ─────────────────────────────────────────

  private assertRunning(automation: AutomationInstance): void {
    if (!this.automations.has(automation.id)) {
      throw new Error(`Automation ${automation.id} is not registered`);
    }
    if (automation.state !== "running") {
      throw new Error(
        `Automation ${automation.id} is not running (state: ${automation.state})`
      );
    }
  }

  async callService(
    automation: AutomationInstance,
    domain: string,
    service: string,
    data?: Record<string, any>
  ): Promise<any> {
    this.assertRunning(automation);
    return this.bridge.request("callService", { domain, service, data });
  }

  subscribeToEvent(
    automation: AutomationInstance,
    eventType: string,
    callback: (event: any) => void | Promise<void>
  ): () => void {
    this.assertRunning(automation);

    const subId = nextSubId();
    this.bridge.sendLog("debug", automation.id, `Subscribing to event: ${eventType} (${subId})`);

    // Register handler on bridge
    this.bridge.onEvent(subId, (data) => {
      if (automation.state !== "running") return;
      try {
        const result = callback(data);
        if (result instanceof Promise) {
          result.catch((e: any) => {
            this.handleAutomationError(automation, e);
          });
        }
      } catch (e: any) {
        this.handleAutomationError(automation, e);
      }
    });

    // Request subscription from main
    this.bridge.request("subscribeEvent", {
      eventType,
      subId,
      automationId: automation.id,
    }).catch((e: any) => {
      this.bridge.sendLog("error", automation.id, `Subscribe failed: ${e.message}`);
    });

    // Track subscription
    const unsub = () => {
      this.bridge.sendLog("debug", automation.id, `Unsubscribing from event: ${eventType} (${subId})`);
      this.bridge.removeHandler(subId);
      this.bridge.request("unsubscribe", { subId }).catch(() => {});
      const subs = this.subscriptions.get(automation.id);
      if (subs) {
        const idx = subs.findIndex((s) => s.subId === subId);
        if (idx >= 0) subs.splice(idx, 1);
      }
    };

    const subs = this.subscriptions.get(automation.id) || [];
    subs.push({ subId, automationId: automation.id, unsub });
    this.subscriptions.set(automation.id, subs);

    return unsub;
  }

  subscribeToStateChangeEvent(
    automation: AutomationInstance,
    entityId: string,
    callback: (data: any) => void | Promise<void>
  ): () => void {
    this.assertRunning(automation);

    const subId = nextSubId();
    const label = entityId ? `state changes for ${entityId}` : "all state changes";
    this.bridge.sendLog("debug", automation.id, `Subscribing to ${label} (${subId})`);

    this.bridge.onStateChange(subId, (evEntityId, oldState, newState) => {
      if (automation.state !== "running") return;
      try {
        const result = callback({ entity_id: evEntityId, old_state: oldState, new_state: newState });
        if (result instanceof Promise) {
          result.catch((e: any) => {
            this.handleAutomationError(automation, e);
          });
        }
      } catch (e: any) {
        this.handleAutomationError(automation, e);
      }
    });

    this.bridge.request("subscribeStateChange", {
      entityId,
      subId,
      automationId: automation.id,
    }).catch((e: any) => {
      this.bridge.sendLog("error", automation.id, `State subscribe failed: ${e.message}`);
    });

    const unsub = () => {
      this.bridge.sendLog("debug", automation.id, `Unsubscribing from ${label} (${subId})`);
      this.bridge.removeHandler(subId);
      this.bridge.request("unsubscribe", { subId }).catch(() => {});
      const subs = this.subscriptions.get(automation.id);
      if (subs) {
        const idx = subs.findIndex((s) => s.subId === subId);
        if (idx >= 0) subs.splice(idx, 1);
      }
    };

    const subs = this.subscriptions.get(automation.id) || [];
    subs.push({ subId, automationId: automation.id, unsub });
    this.subscriptions.set(automation.id, subs);

    return unsub;
  }

  onStateChange(
    automation: AutomationInstance,
    callback: (data: any) => void | Promise<void>
  ): () => void {
    // Same as subscribeToStateChangeEvent but without entity filter
    return this.subscribeToStateChangeEvent(automation, "", callback);
  }

  async getEntityState(entityId: string): Promise<any> {
    return this.bridge.request("getEntityState", { entityId });
  }

  async fetchEntityState(entityId: string): Promise<any> {
    return this.bridge.request("fetchEntityState", { entityId });
  }

  // ─── Storage API ───────────────────────────────────────────

  async storageGet(namespace: string, key: string, persistent: boolean): Promise<any> {
    return this.bridge.request("storageGet", { namespace, key, persistent });
  }

  async storageSet(namespace: string, key: string, value: any, persistent: boolean): Promise<void> {
    await this.bridge.request("storageSet", { namespace, key, value, persistent });
  }

  async storageDelete(namespace: string, key: string, persistent: boolean): Promise<void> {
    await this.bridge.request("storageDelete", { namespace, key, persistent });
  }

  // ─── Logging ───────────────────────────────────────────────

  logMessage(level: string, automationId: string, message: any, extra?: any): void {
    this.bridge.sendLog(level, automationId, message, extra);
  }

  // ─── Internal ──────────────────────────────────────────────

  private async cleanupSubscriptions(automationId: string): Promise<void> {
    const subs = this.subscriptions.get(automationId) || [];
    for (const sub of subs) {
      try { sub.unsub(); } catch {}
    }
    this.subscriptions.set(automationId, []);

    // Also tell main to clean up
    await this.bridge.request("unsubscribeAll", { automationId }).catch(() => {});
  }

  private handleAutomationError(automation: AutomationInstance, e: any): void {
    this.bridge.sendLog(
      "error",
      automation.id,
      `Runtime error: ${e.message}`,
      { stack: e.stack }
    );
    // Mark as error state and stop
    automation.state = "error";
    automation.errorMessage = e.message;
    this.bridge.sendAutomationStateChanged(automation.id, "error", e.message);
    this.cleanupSubscriptions(automation.id).catch(() => {});
  }
}
