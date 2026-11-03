/**
 * Automation Manager — manages automation lifecycle inside the worker thread.
 *
 * Responsibilities:
 * - Register, start, stop automations
 * - Keep a local copy of all HA entity states (sync reads, ordered updates)
 * - Dispatch state changes to automation subscriptions
 * - Clean up subscriptions on stop
 * - Record a trace per trigger (timeline): service calls, logs and errors it caused
 * - Talk to the host (main thread, or the test simulation) for HA and storage operations
 */

import { AsyncLocalStorage } from "async_hooks";
import { WorkerHost, formatLogMessage } from "./bridge";
import { HAEntityState, ShutdownReason, TraceAction, TraceInfo, TraceTrigger } from "../shared/messages";

const TRACE_MAX_ACTIONS = 100;
const TRACE_FLUSH_MS = 250;
const TRACE_LOG_MAX_CHARS = 500;
const nativeSetTimeout = setTimeout; //< flushes must not create timer traces themselves

// Import Automation type — at runtime this is the compiled version
type AutomationInstance = import("../api/automation").Automation;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewTraceAction = DistributiveOmit<TraceAction, "at">;

interface SubscriptionInfo {
  subId: string;
  automationId: string;
  unsub: () => void;
}

interface StateSubscription {
  automation: AutomationInstance;
  entityId: string; //< "" = all entities
  emitAll: boolean;
  callback: (data: any) => void | Promise<void>;
}

interface ActiveTrace {
  info: TraceInfo;
  hasContent: boolean;
  ended: boolean;
  flushPending: boolean;
}

let subIdCounter = 0;
function nextSubId(): string {
  subIdCounter++;
  return `sub_${subIdCounter}`;
}

let traceCounter = 0;

function describeTrigger(trigger: TraceTrigger): string {
  switch (trigger.kind) {
    case "start":
      return "onStart";
    case "state":
      return `${trigger.entityId} ${trigger.from ?? "none"} → ${trigger.to ?? "none"}`;
    case "event":
      return `event ${trigger.eventType}`;
    case "timer":
      return `${trigger.interval ? "interval" : "timer"} ${trigger.delayMs}ms after ${trigger.parent}`;
  }
}

export class AutomationManager {
  private bridge: WorkerHost;
  private automations = new Map<string, AutomationInstance>();
  private subscriptions = new Map<string, SubscriptionInfo[]>(); // automationId → subs
  private stateSubscriptions = new Map<string, StateSubscription>(); // subId → subscription
  private stateCache = new Map<string, HAEntityState>();
  private traceContext = new AsyncLocalStorage<ActiveTrace>();
  private tracing = false;
  private startFilter: Set<string> | null = null;

  constructor(bridge: WorkerHost, initialStates: HAEntityState[] = []) {
    this.bridge = bridge;
    this.replaceStates(initialStates);
    bridge.onStateChanged((entityId, oldState, newState) => this.handleStateChanged(entityId, oldState, newState));
    bridge.onStateSnapshot((states) => this.replaceStates(states));
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
    if (this.startFilter && !this.startFilter.has(automation.id)) {
      this.bridge.sendLog("debug", automation.id, "Not started: not selected for this test");
      return;
    }

    const trace = this.beginTrace(automation.id, { kind: "start" });
    try {
      automation.state = "running";
      automation.errorMessage = undefined;
      this.bridge.sendAutomationStateChanged(automation.id, "running");
      await this.traceContext.run(trace, () => automation.onStart());
      this.endTrace(trace);
    } catch (err: any) {
      this.recordIn(trace, { kind: "error", message: err.message });
      this.endTrace(trace, err.message);
      automation.state = "error";
      automation.errorMessage = err.message;
      this.bridge.sendAutomationStateChanged(automation.id, "error", err.message);
      this.bridge.sendLog("error", automation.id, `onStart failed: ${err.message}`, { stack: err.stack });
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
    } catch (err: any) {
      this.bridge.sendLog("error", automation.id, `onStop error: ${err.message}`, { stack: err.stack });
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

  /** Stop and unload every automation; on a reload, onReload() runs first. */
  async unloadAll(reason: ShutdownReason = "stop"): Promise<void> {
    if (reason === "reload") {
      for (const automation of this.automations.values()) {
        try {
          await automation.onReload();
        } catch (err: any) {
          this.bridge.sendLog("error", automation.id, `onReload error: ${err.message}`, { stack: err.stack });
        }
      }
    }
    for (const automation of this.automations.values()) {
      if (automation.state === "running" || automation.state === "error") {
        await this.stop(automation);
      }
      try {
        await automation.onUnload();
      } catch (err: any) {
        this.bridge.sendLog("error", automation.id, `onUnload error: ${err.message}`);
      }
    }
    this.automations.clear();
    this.subscriptions.clear();
    this.stateSubscriptions.clear();
  }

  getAutomations(): Array<{ id: string; className: string; state: string; error?: string }> {
    return Array.from(this.automations.values()).map((automation) => ({
      id: automation.id,
      className: automation.className,
      state: automation.state,
      error: automation.errorMessage,
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
    this.bridge.sendLog(
      "debug",
      automation.id,
      `Calling service ${domain}.${service}`,
      data
    );
    const recorded = this.record({ kind: "service", domain, service, data });
    try {
      return await this.bridge.request("callService", { domain, service, data, automationId: automation.id });
    } catch (err: any) {
      if (recorded && recorded.action.kind === "service") {
        recorded.action.error = err.message;
        this.scheduleFlush(recorded.trace);
      }
      throw err;
    }
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
      this.invokeCallback(automation, () => callback(data), { kind: "event", eventType });
    });

    // Request subscription from main
    this.bridge.request("subscribeEvent", {
      eventType,
      subId,
      automationId: automation.id,
    }).catch((err: any) => {
      this.bridge.sendLog("error", automation.id, `Subscribe failed: ${err.message}`);
    });

    const unsub = () => {
      this.bridge.sendLog("debug", automation.id, `Unsubscribing from event: ${eventType} (${subId})`);
      this.bridge.removeHandler(subId);
      this.bridge.request("unsubscribe", { subId }).catch(() => {});
      this.untrack(automation.id, subId);
    };
    this.track(automation.id, subId, unsub);
    return unsub;
  }

  subscribeToStateChangeEvent(
    automation: AutomationInstance,
    entityId: string,
    callback: (data: any) => void | Promise<void>,
    emitAll: boolean = false
  ): () => void {
    this.assertRunning(automation);

    const subId = nextSubId();
    const label = entityId ? `state changes for ${entityId}` : "all state changes";
    this.bridge.sendLog("debug", automation.id, `Subscribing to ${label} (${subId})`);

    this.stateSubscriptions.set(subId, { automation, entityId, emitAll, callback });

    const unsub = () => {
      this.bridge.sendLog("debug", automation.id, `Unsubscribing from ${label} (${subId})`);
      this.stateSubscriptions.delete(subId);
      this.untrack(automation.id, subId);
    };
    this.track(automation.id, subId, unsub);
    return unsub;
  }

  onStateChange(
    automation: AutomationInstance,
    callback: (data: any) => void | Promise<void>,
    emitAll: boolean = false
  ): () => void {
    // Same as subscribeToStateChangeEvent but without entity filter
    return this.subscribeToStateChangeEvent(automation, "", callback, emitAll);
  }

  /** Read an entity from the worker's local state copy. */
  getEntityStateSync(entityId: string): HAEntityState | undefined {
    return this.stateCache.get(entityId);
  }

  async getEntityState(entityId: string): Promise<HAEntityState | undefined> {
    return this.getEntityStateSync(entityId);
  }

  async fetchEntityState(entityId: string): Promise<HAEntityState | undefined> {
    const state: HAEntityState | undefined = await this.bridge.request("fetchEntityState", { entityId });
    if (state) {
      this.stateCache.set(entityId, state);
    }
    return state;
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
    this.record({ kind: "log", level, message: formatLogMessage(message).slice(0, TRACE_LOG_MAX_CHARS) });
  }

  // ─── Test runs ─────────────────────────────────────────────

  /** Test runs: only these automations start (null or empty = all). */
  setStartFilter(automationIds: string[] | null): void {
    this.startFilter = automationIds && automationIds.length > 0 ? new Set(automationIds) : null;
  }

  // ─── Timeline ──────────────────────────────────────────────

  /**
   * Record a trace per trigger. Timers started inside a traced callback get
   * their own trace, so delayed actions show what scheduled them.
   */
  enableTracing(): void {
    this.tracing = true;
    const manager = this;
    const wrapTimer = (original: Function, interval: boolean): Function => {
      const wrapped = function (this: unknown, callback: unknown, delay?: number, ...args: unknown[]) {
        const parent = manager.traceContext.getStore();
        if (!parent || typeof callback !== "function") return original.call(this, callback, delay, ...args);
        return original.call(
          this,
          () => manager.runTimer(parent, delay ?? 0, interval, () => (callback as Function)(...args)),
          delay
        );
      };
      for (const key of Reflect.ownKeys(original)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        try {
          (wrapped as any)[key] = (original as any)[key]; //< keeps util.promisify.custom working
        } catch {}
      }
      return wrapped;
    };
    (globalThis as any).setTimeout = wrapTimer(globalThis.setTimeout, false);
    (globalThis as any).setInterval = wrapTimer(globalThis.setInterval, true);
  }

  private runTimer(parent: ActiveTrace, delay: number, interval: boolean, run: () => unknown): void {
    const automation = this.automations.get(parent.info.automationId);
    if (!automation) {
      run();
      return;
    }
    this.invokeCallback(automation, run as () => void | Promise<void>, {
      kind: "timer",
      delayMs: delay,
      interval,
      parent: describeTrigger(parent.info.trigger),
    });
  }

  private beginTrace(automationId: string, trigger: TraceTrigger): ActiveTrace {
    traceCounter++;
    return {
      info: { id: `t${traceCounter}`, automationId, startedAt: Date.now(), trigger, actions: [] },
      hasContent: false,
      ended: false,
      flushPending: false,
    };
  }

  /** Add an action to the trace of the code that is running now. */
  private record(action: NewTraceAction): { trace: ActiveTrace; action: TraceAction } | undefined {
    const trace = this.traceContext.getStore();
    if (!trace) return undefined;
    return this.recordIn(trace, action);
  }

  private recordIn(trace: ActiveTrace, partial: NewTraceAction): { trace: ActiveTrace; action: TraceAction } | undefined {
    if (!this.tracing) return undefined;
    if (trace.info.actions.length >= TRACE_MAX_ACTIONS) {
      trace.info.truncated = true;
      return undefined;
    }
    const action = { ...partial, at: Date.now() - trace.info.startedAt } as TraceAction;
    trace.info.actions.push(action);
    trace.hasContent = true;
    this.scheduleFlush(trace);
    return { trace, action };
  }

  private endTrace(trace: ActiveTrace, error?: string): void {
    if (!this.tracing || trace.ended) return;
    trace.ended = true;
    trace.info.durationMs = Date.now() - trace.info.startedAt;
    if (error) {
      trace.info.error = error;
      trace.hasContent = true;
    }
    if (!trace.hasContent) {
      if (trace.info.trigger.kind !== "timer") {
        this.bridge.sendTraceIgnored(trace.info.automationId, trace.info.startedAt, trace.info.trigger);
      }
      return;
    }
    this.flushTrace(trace);
  }

  private scheduleFlush(trace: ActiveTrace): void {
    if (trace.flushPending) return;
    trace.flushPending = true;
    nativeSetTimeout(() => this.flushTrace(trace), TRACE_FLUSH_MS);
  }

  private flushTrace(trace: ActiveTrace): void {
    trace.flushPending = false;
    if (!trace.hasContent) return;
    this.bridge.sendTrace({ ...trace.info, actions: [...trace.info.actions] });
  }

  // ─── Internal ──────────────────────────────────────────────

  private replaceStates(states: HAEntityState[]): void {
    this.stateCache.clear();
    for (const state of states) {
      this.stateCache.set(state.entity_id, state);
    }
  }

  /** Update the local copy first so callbacks see the new state, then dispatch. */
  private handleStateChanged(entityId: string, oldState: HAEntityState | null, newState: HAEntityState | null): void {
    if (newState) {
      this.stateCache.set(entityId, newState);
    } else {
      this.stateCache.delete(entityId);
    }

    for (const sub of this.stateSubscriptions.values()) {
      if (sub.entityId && sub.entityId !== entityId) continue;
      if (sub.automation.state !== "running") continue;
      // Default: skip removals and attribute-only changes. emitAll=true receives everything.
      if (!sub.emitAll) {
        if (!newState) continue;
        if (oldState && newState.state === oldState.state) continue;
      }
      this.invokeCallback(
        sub.automation,
        () => sub.callback({ entity_id: entityId, old_state: oldState, new_state: newState }),
        { kind: "state", entityId, from: oldState?.state ?? null, to: newState?.state ?? null }
      );
    }
  }

  private invokeCallback(automation: AutomationInstance, run: () => void | Promise<void>, trigger: TraceTrigger): void {
    const trace = this.beginTrace(automation.id, trigger);
    this.traceContext.run(trace, () => {
      try {
        const result = run();
        if (result instanceof Promise) {
          result.then(
            () => this.endTrace(trace),
            (err: any) => {
              this.handleAutomationError(automation, err);
              this.endTrace(trace, err?.message ?? String(err));
            }
          );
        } else {
          this.endTrace(trace);
        }
      } catch (err: any) {
        this.handleAutomationError(automation, err);
        this.endTrace(trace, err?.message ?? String(err));
      }
    });
  }

  private track(automationId: string, subId: string, unsub: () => void): void {
    const subs = this.subscriptions.get(automationId) || [];
    subs.push({ subId, automationId, unsub });
    this.subscriptions.set(automationId, subs);
  }

  private untrack(automationId: string, subId: string): void {
    const subs = this.subscriptions.get(automationId);
    if (!subs) return;
    const idx = subs.findIndex((sub) => sub.subId === subId);
    if (idx >= 0) subs.splice(idx, 1);
  }

  private async cleanupSubscriptions(automationId: string): Promise<void> {
    const subs = [...(this.subscriptions.get(automationId) || [])];
    for (const sub of subs) {
      try { sub.unsub(); } catch {}
    }
    this.subscriptions.set(automationId, []);

    // Also tell main to clean up
    await this.bridge.request("unsubscribeAll", { automationId }).catch(() => {});
  }

  /**
   * A callback threw or rejected. Log it and keep the automation running —
   * one failed service call must not disable the automation.
   */
  private handleAutomationError(automation: AutomationInstance, err: any): void {
    const message = err?.message ?? String(err);
    this.bridge.sendLog("error", automation.id, `Runtime error: ${message}`, { stack: err?.stack });
    this.bridge.sendAutomationError(automation.id, message);
    this.record({ kind: "error", message });
  }
}
