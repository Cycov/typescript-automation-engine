/**
 * Test host — stands in for the main thread during a test run.
 * Service calls are recorded (and optionally applied to the simulated states);
 * with live calls they are also sent to Home Assistant. Storage lives in memory,
 * published entities become simulated states (as Home Assistant would show them),
 * and every log, error and call lands on the test timeline.
 */

import { EventHandler, StateChangedHandler, StateSnapshotHandler, WorkerHost, formatLogMessage } from "./bridge";
import { HAEntityState, TraceInfo, TraceTrigger } from "../shared/messages";
import { TestTimelineItem, TestTimelineKind } from "../shared/tests";

const realSetImmediate = setImmediate;
const LOG_TEXT_MAX_CHARS = 1000;
const MAX_TIMELINE_ITEMS = 2000;
const EMPTY_CONTEXT = { id: "test", parent_id: null, user_id: null };

export interface RecordedServiceCall {
  at: number;
  automationId: string;
  domain: string;
  service: string;
  data: Record<string, any>;
  entityIds: string[];
}

/** Sends a service call to Home Assistant through the main thread. */
export type LiveServiceCaller = (args: { domain: string; service: string; data: Record<string, any>; automationId?: string; returnResponse?: boolean }) => Promise<any>;
export type LiveAIGenerator = (args: { automationId: string; prompt: string; options: Record<string, any> }) => Promise<string>;

const AI_PLACEHOLDER_PROMPT_CHARS = 80;

export interface TestHostOptions {
  startTimeMs: number;
  applyEffects: boolean;
  storage: Record<string, Record<string, any>>;
  /** Set to send service calls to Home Assistant. */
  liveCaller?: LiveServiceCaller;
  /** Set to answer this.ai.generate with the real AI (live runs); otherwise a placeholder text. */
  liveAI?: LiveAIGenerator;
}

interface StateEffect {
  entityId: string;
  state?: string;
  attributes?: Record<string, any>;
}

const ON_OFF_DOMAINS = new Set(["light", "switch", "fan", "input_boolean", "siren", "humidifier", "automation", "script", "remote", "media_player", "climate", "water_heater"]);
const VALUE_DOMAINS = new Set(["input_number", "number", "input_text", "text"]);
const OPTION_DOMAINS = new Set(["input_select", "select"]);
const NON_ATTRIBUTE_KEYS = new Set(["entity_id", "transition", "flash", "effect_list", "device_id", "area_id"]);
const PUBLISHED_DEVICE_NAME = "TAE"; //< Home Assistant names published entities after their device
const MQTT_STATES: Record<string, string> = { ON: "on", OFF: "off", None: "unknown" }; //< payloads → HA states

/**
 * True when `actual` has every value of `expected`: objects compare key by key (extra keys are fine),
 * arrays and plain values must be equal.
 */
export function matchesSubset(actual: any, expected: any): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, iItem) => matchesSubset(actual[iItem], item));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => matchesSubset(actual[key], value));
}

/** Entity ids a service call targets (data.entity_id or data.target.entity_id). */
export function serviceTargets(data: Record<string, any> | undefined): string[] {
  const raw = data?.entity_id ?? data?.target?.entity_id;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

/** What Home Assistant would most likely do with a service call, for common domains. */
function serviceEffects(domain: string, service: string, data: Record<string, any>, current: (entityId: string) => HAEntityState | undefined): StateEffect[] {
  const effects: StateEffect[] = [];
  for (const entityId of serviceTargets(data)) {
    const entityDomain = entityId.split(".")[0];
    if (entityDomain !== domain && domain !== "homeassistant") continue;
    const before = current(entityId);
    const attributes: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!NON_ATTRIBUTE_KEYS.has(key)) attributes[key] = value;
    }

    if (service === "turn_on" && ON_OFF_DOMAINS.has(entityDomain)) {
      effects.push({ entityId, state: entityDomain === "climate" ? before?.attributes?.hvac_mode || "heat" : "on", attributes });
    } else if (service === "turn_off" && ON_OFF_DOMAINS.has(entityDomain)) {
      effects.push({ entityId, state: "off" });
    } else if (service === "toggle" && ON_OFF_DOMAINS.has(entityDomain)) {
      effects.push({ entityId, state: before?.state === "on" ? "off" : "on" });
    } else if (entityDomain === "cover") {
      if (service === "open_cover") effects.push({ entityId, state: "open", attributes: { current_position: 100 } });
      else if (service === "close_cover") effects.push({ entityId, state: "closed", attributes: { current_position: 0 } });
      else if (service === "set_cover_position" && typeof data.position === "number") {
        effects.push({ entityId, state: data.position > 0 ? "open" : "closed", attributes: { current_position: data.position } });
      } else if (service === "toggle") effects.push({ entityId, state: before?.state === "open" ? "closed" : "open" });
    } else if (entityDomain === "lock") {
      if (service === "lock") effects.push({ entityId, state: "locked" });
      else if (service === "unlock") effects.push({ entityId, state: "unlocked" });
    } else if (entityDomain === "media_player") {
      const states: Record<string, string> = { media_play: "playing", media_pause: "paused", media_stop: "idle" };
      if (states[service]) effects.push({ entityId, state: states[service] });
      else if (service === "volume_set") effects.push({ entityId, attributes: { volume_level: data.volume_level } });
    } else if (entityDomain === "climate") {
      if (service === "set_hvac_mode" && data.hvac_mode) effects.push({ entityId, state: String(data.hvac_mode) });
      else if (service === "set_temperature") effects.push({ entityId, attributes });
    } else if (VALUE_DOMAINS.has(entityDomain) && service === "set_value" && data.value !== undefined) {
      effects.push({ entityId, state: String(data.value) });
    } else if (OPTION_DOMAINS.has(entityDomain) && service === "select_option" && data.option !== undefined) {
      effects.push({ entityId, state: String(data.option) });
    } else if (entityDomain === "vacuum") {
      const states: Record<string, string> = { start: "cleaning", return_to_base: "returning", stop: "idle", pause: "paused" };
      if (states[service]) effects.push({ entityId, state: states[service] });
    }
  }
  return effects;
}

export class TestHost implements WorkerHost {
  readonly states = new Map<string, HAEntityState>();
  readonly items: TestTimelineItem[] = [];
  readonly calls: RecordedServiceCall[] = [];
  private startTimeMs: number;
  private applyEffects: boolean;
  private liveCaller?: LiveServiceCaller;
  private liveAI?: LiveAIGenerator;
  private pendingLiveCalls = new Set<Promise<unknown>>();
  liveCallCount = 0;
  private eventHandlers = new Map<string, EventHandler>(); // subId → handler
  private eventTypes = new Map<string, string>(); // subId → event type
  private stateChangedHandler?: StateChangedHandler;
  private persistent = new Map<string, any>();
  private temp = new Map<string, any>();
  private currentStep: number | undefined;

  constructor(states: HAEntityState[], options: TestHostOptions) {
    for (const state of states) this.states.set(state.entity_id, state);
    this.startTimeMs = options.startTimeMs;
    this.applyEffects = options.applyEffects;
    this.liveCaller = options.liveCaller;
    this.liveAI = options.liveAI;
    for (const [namespace, entries] of Object.entries(options.storage || {})) {
      for (const [key, value] of Object.entries(entries)) this.persistent.set(`${namespace}:${key}`, value);
    }
  }

  /** Simulated ms since the scenario started (Date is faked during a run). */
  now(): number {
    return Date.now() - this.startTimeMs;
  }

  get live(): boolean {
    return !!this.liveCaller;
  }

  /** Resolves once every service call sent to Home Assistant has answered. */
  async waitForLiveCalls(): Promise<void> {
    while (this.pendingLiveCalls.size > 0) {
      await Promise.allSettled(Array.from(this.pendingLiveCalls));
    }
  }

  setCurrentStep(step: number | undefined): void {
    this.currentStep = step;
  }

  add(kind: TestTimelineKind, text: string, extra: Partial<TestTimelineItem> = {}): void {
    if (this.items.length >= MAX_TIMELINE_ITEMS) return;
    this.items.push({ at: this.now(), kind, text, ...(this.currentStep !== undefined ? { step: this.currentStep } : {}), ...extra });
  }

  /** Change an entity as Home Assistant would report it, and dispatch the change. replace: the attributes replace the old ones. */
  setState(entityId: string, state: string | undefined, attributes: Record<string, any> | undefined, replace = false): HAEntityState {
    const before = this.states.get(entityId) ?? null;
    const nowIso = new Date().toISOString();
    const nextState = state ?? before?.state ?? "unknown";
    const after: HAEntityState = {
      entity_id: entityId,
      state: nextState,
      attributes: replace ? { ...(attributes || {}) } : { ...(before?.attributes || {}), ...(attributes || {}) },
      last_changed: before && before.state === nextState ? before.last_changed : nowIso,
      last_updated: nowIso,
      context: EMPTY_CONTEXT,
    };
    this.states.set(entityId, after);
    this.stateChangedHandler?.(entityId, before, after);
    return after;
  }

  /** Remove an entity, as Home Assistant does when its integration deletes it. */
  removeState(entityId: string): void {
    const before = this.states.get(entityId);
    if (!before) return;
    this.states.delete(entityId);
    this.stateChangedHandler?.(entityId, before, null);
  }

  /** A TAE restart: temp storage is gone; persistent storage and states stay. */
  restart(): void {
    this.temp.clear();
    this.eventHandlers.clear();
    this.eventTypes.clear();
  }

  /** Deliver a Home Assistant event to every subscription for its type. */
  fireEvent(eventType: string, data: Record<string, any>): number {
    let delivered = 0;
    const event = { event_type: eventType, data, origin: "LOCAL", time_fired: new Date().toISOString(), context: EMPTY_CONTEXT };
    for (const [subId, type] of this.eventTypes) {
      if (type !== eventType && type !== "*") continue;
      this.eventHandlers.get(subId)?.(event);
      delivered++;
    }
    return delivered;
  }

  // ─── WorkerHost ─────────────────────────────────────────────

  async request(method: string, args: any): Promise<any> {
    switch (method) {
      case "callService":
        return this.recordServiceCall(args);
      case "aiGenerate":
        return this.aiGenerate(args);
      case "publishEntity":
        this.publishEntity(args);
        return null;
      case "removeEntity":
        this.add("info", `${args.component}.${args.objectId} removed (simulated)`, { automationId: args.automationId });
        this.removeState(`${args.component}.${args.objectId}`);
        return null;
      case "getEntityState":
      case "fetchEntityState":
        return this.states.get(args.entityId);
      case "subscribeEvent":
        this.eventTypes.set(args.subId, args.eventType);
        return true;
      case "unsubscribe":
        this.eventTypes.delete(args.subId);
        return true;
      case "unsubscribeAll":
        return true;
      case "storageGet":
        return this.store(args.persistent).get(`${args.namespace}:${args.key}`);
      case "storageSet":
        this.store(args.persistent).set(`${args.namespace}:${args.key}`, args.value);
        return true;
      case "storageDelete":
        this.store(args.persistent).delete(`${args.namespace}:${args.key}`);
        return true;
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  onEvent(subId: string, handler: EventHandler): void {
    this.eventHandlers.set(subId, handler);
  }

  removeHandler(subId: string): void {
    this.eventHandlers.delete(subId);
    this.eventTypes.delete(subId);
  }

  onStateChanged(handler: StateChangedHandler): void {
    this.stateChangedHandler = handler;
  }

  onStateSnapshot(_handler: StateSnapshotHandler): void {}

  sendLog(level: string, automationId: string, message: any, extra?: any): void {
    if (level === "debug" && /^(Calling service|Subscribing to|Unsubscribing from|Not started)/.test(String(message))) return; //< summarized elsewhere
    if (automationId === "worker") return; //< loader chatter; load failures arrive as errors
    let text = formatLogMessage(message);
    if (extra && level === "error" && extra.stack) text += `\n${extra.stack}`;
    this.add("log", text.slice(0, LOG_TEXT_MAX_CHARS), { automationId, level });
  }

  sendAutomationRegistered(): void {}

  sendAutomationStateChanged(id: string, state: string, error?: string): void {
    if (state === "error") this.add("error", `${id} failed to start: ${error}`, { automationId: id });
  }

  sendAutomationError(id: string, error: string): void {
    this.add("error", error, { automationId: id });
  }

  sendError(message: string, stack?: string): void {
    this.add("error", stack ? `${message}\n${stack}`.slice(0, LOG_TEXT_MAX_CHARS) : message);
  }

  sendTrace(_trace: TraceInfo): void {}

  sendTraceIgnored(_automationId: string, _at: number, _trigger: TraceTrigger): void {}

  // ─── Internal ───────────────────────────────────────────────

  /** this.publish.*: the entity appears in the simulated states as Home Assistant would show it. */
  private publishEntity(args: { automationId: string; component: string; objectId: string; options?: Record<string, any>; state: string; attributes?: Record<string, any> }): void {
    const entityId = `${args.component}.${args.objectId}`;
    const state = MQTT_STATES[args.state] ?? args.state;
    const options = args.options ?? {};
    const own: Record<string, any> = {
      ...(options.name ? { friendly_name: `${options.device?.trim() || PUBLISHED_DEVICE_NAME} ${options.name}` } : {}),
      ...(options.icon ? { icon: options.icon } : {}),
      ...(options.unit ? { unit_of_measurement: options.unit } : {}),
      ...(options.deviceClass ? { device_class: options.deviceClass } : {}),
    };
    // like MQTT: new attributes replace the old ones; none given keeps them
    const previous = this.states.get(entityId);
    const attributes = args.attributes ? { ...own, ...args.attributes } : { ...(previous?.attributes ?? {}), ...own };
    this.setState(entityId, state, attributes, true);
    this.add("info", `${entityId} = ${state} (published, simulated)`, { automationId: args.automationId, detail: args.attributes });
  }

  private store(persistent: boolean): Map<string, any> {
    return persistent ? this.persistent : this.temp;
  }

  /** this.ai.generate in a test: the real AI on live runs, a placeholder otherwise. */
  private aiGenerate(args: { automationId: string; prompt: string; options: Record<string, any> }): Promise<string> {
    const promptStart = args.prompt.slice(0, AI_PLACEHOLDER_PROMPT_CHARS);
    if (!this.liveAI) {
      this.add("info", `AI text (placeholder, not sent): ${promptStart}`, { automationId: args.automationId, detail: args });
      return Promise.resolve(`[AI text for: ${promptStart}]`);
    }
    const sent = this.liveAI(args).then((text) => {
      this.add("info", `AI text: ${text}`, { automationId: args.automationId, detail: args });
      return text;
    });
    const tracked = sent.then(
      () => {},
      (err: any) => this.add("error", `AI request failed: ${err?.message ?? err}`, { automationId: args.automationId })
    );
    this.pendingLiveCalls.add(tracked);
    tracked.finally(() => this.pendingLiveCalls.delete(tracked));
    return sent;
  }

  private recordServiceCall(args: { domain: string; service: string; data?: Record<string, any>; automationId?: string; returnResponse?: boolean }): Promise<any> | null {
    const data = args.data || {};
    const call: RecordedServiceCall = {
      at: this.now(),
      automationId: args.automationId || "",
      domain: args.domain,
      service: args.service,
      data,
      entityIds: serviceTargets(data),
    };
    this.calls.push(call);
    const callText = `${args.domain}.${args.service}${call.entityIds.length ? " → " + call.entityIds.join(", ") : ""}`;
    this.add("service", callText, {
      automationId: call.automationId,
      detail: data,
      ...(this.liveCaller ? { live: true } : {}),
    });

    if (this.applyEffects) {
      const effects = serviceEffects(args.domain, args.service, data, (entityId) => this.states.get(entityId));
      if (effects.length > 0) {
        // After the caller's current microtasks, like a real round trip to Home Assistant
        realSetImmediate(() => {
          for (const effect of effects) {
            const before = this.states.get(effect.entityId)?.state;
            const after = this.setState(effect.entityId, effect.state, effect.attributes);
            const change = before === after.state ? "attributes updated" : `${before ?? "none"} → ${after.state}`;
            this.add("effect", `${effect.entityId}: ${change}`, { automationId: call.automationId });
          }
        });
      }
    }

    if (!this.liveCaller) return null;
    this.liveCallCount++;
    const sent = this.liveCaller({
      domain: args.domain,
      service: args.service,
      data,
      automationId: call.automationId,
      ...(args.returnResponse ? { returnResponse: true } : {}),
    });
    const tracked = sent.then(
      () => {},
      (err: any) => this.add("error", `Home Assistant rejected ${callText}: ${err?.message ?? err}`, { automationId: call.automationId })
    );
    this.pendingLiveCalls.add(tracked);
    tracked.finally(() => this.pendingLiveCalls.delete(tracked));
    return sent;
  }
}
