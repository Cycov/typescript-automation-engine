/**
 * Home Assistant WebSocket Client
 *
 * Connects to HA via WebSocket, manages authentication, state caching,
 * and provides API for calling services and subscribing to events.
 */

import WebSocket from "ws";
import { HAEntityState, HAEvent } from "../shared/messages";

const HA_WS_URL = process.env.TAE_HA_WS_URL || "ws://supervisor/core/websocket"; //< env override for local development
const HA_REST_URL = process.env.TAE_HA_REST_URL || "http://supervisor/core/api";
const RECONNECT_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const REGISTRY_CACHE_MS = 60000; //< registries and services change rarely

type StateChangeCallback = (data: {
  entity_id: string;
  old_state: HAEntityState | null;
  new_state: HAEntityState | null;
}) => void;

type EventCallback = (event: HAEvent) => void;

export interface HARegistries {
  devices: any[];
  entities: any[];
  areas: any[];
}

interface ActiveEventSub {
  eventType: string;
  callback: EventCallback;
  currentId: number;
}

export class HAClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private eventSubscriptions = new Map<number, EventCallback>();
  private stateChangeCallbacks: StateChangeCallback[] = [];
  private activeEventSubs: ActiveEventSub[] = [];
  private allStates = new Map<string, HAEntityState>();
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private supervisorToken: string;
  private onConnectCb?: () => void;
  private logFn: (level: string, source: string, message: string, extra?: any) => void;
  private registriesCache: { at: number; data: HARegistries } | null = null;
  private servicesCache: { at: number; data: Record<string, any> } | null = null;

  constructor(options: {
    supervisorToken: string;
    logFn: (level: string, source: string, message: string, extra?: any) => void;
    /** Called after every successful (re)connect, once states are loaded. */
    onConnect?: () => void;
  }) {
    this.supervisorToken = options.supervisorToken;
    this.logFn = options.logFn;
    this.onConnectCb = options.onConnect;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logFn("info", "ha-client", "Connecting to Home Assistant WebSocket...");

      const ws = new WebSocket(HA_WS_URL);
      this.ws = ws;

      ws.on("open", () => {
        this.logFn("info", "ha-client", "WebSocket connection opened");
      });

      ws.on("message", (data: WebSocket.Data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: this.supervisorToken }));
          return;
        }

        if (msg.type === "auth_ok") {
          this.connected = true;
          this.logFn("info", "ha-client", "Authenticated with Home Assistant");
          this.fetchAllStates()
            .then(() => this.subscribeToStateChanges())
            .then(() => this.resubscribeActiveEvents())
            .then(() => {
              this.onConnectCb?.();
              resolve();
            })
            .catch(reject);
          return;
        }

        if (msg.type === "auth_invalid") {
          this.logFn("error", "ha-client", `Authentication failed: ${msg.message}`);
          reject(new Error(`Auth failed: ${msg.message}`));
          return;
        }

        // Subscription events
        if (msg.type === "event" && msg.id) {
          const cb = this.eventSubscriptions.get(msg.id);
          if (cb) {
            cb(msg.event);
          }
          return;
        }

        // Request responses
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve: resolveRequest, reject: rejectRequest } = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.success === false) {
            rejectRequest(new Error(msg.error?.message || "Request failed"));
          } else {
            resolveRequest(msg.result);
          }
          return;
        }
      });

      ws.on("close", () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.eventSubscriptions.clear();
        this.rejectAllPending(new Error("Home Assistant connection closed"));
        this.logFn("warn", "ha-client", `WebSocket closed, reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
        this.scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        this.logFn("error", "ha-client", `WebSocket error: ${err.message}`);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err: any) {
        this.logFn("error", "ha-client", `Reconnect failed: ${err.message}`);
        this.scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }

  private rejectAllPending(error: Error): void {
    for (const { reject } of this.pendingRequests.values()) {
      try { reject(error); } catch {}
    }
    this.pendingRequests.clear();
  }

  private nextId(): number {
    this.msgId++;
    return this.msgId;
  }

  private sendCommand(msg: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        reject(new Error("Not connected to Home Assistant"));
        return;
      }
      const id = this.nextId();
      msg.id = id;
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${id} (${msg.type}) timed out`));
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }

  private async fetchAllStates(): Promise<void> {
    const states: HAEntityState[] = await this.sendCommand({ type: "get_states" });
    this.allStates.clear();
    for (const state of states) {
      this.allStates.set(state.entity_id, state);
    }
    this.logFn("info", "ha-client", `Loaded ${this.allStates.size} entity states`);
  }

  /** One HA subscription for state_changed feeds the cache and all state listeners. */
  private async subscribeToStateChanges(): Promise<void> {
    const id = this.nextId();
    this.eventSubscriptions.set(id, (event: HAEvent) => {
      const entityId = event.data.entity_id;
      if (event.data.new_state) {
        this.allStates.set(entityId, event.data.new_state);
      } else {
        this.allStates.delete(entityId);
      }
      for (const cb of this.stateChangeCallbacks) {
        try {
          cb({
            entity_id: entityId,
            old_state: event.data.old_state,
            new_state: event.data.new_state,
          });
        } catch (err: any) {
          this.logFn("error", "ha-client", `State change callback error: ${err.message}`, {
            stack: err.stack,
          });
        }
      }
    });

    await new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("Not connected"));
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type: "subscribe_events", event_type: "state_changed" }));
    });
  }

  getEntityState(entityId: string): HAEntityState | undefined {
    return this.allStates.get(entityId);
  }

  getAllStates(): HAEntityState[] {
    return Array.from(this.allStates.values());
  }

  /** Fetch one entity live from HA's REST API and refresh the cache. */
  async fetchEntityState(entityId: string): Promise<HAEntityState | undefined> {
    const res = await fetch(`${HA_REST_URL}/states/${encodeURIComponent(entityId)}`, {
      headers: { Authorization: `Bearer ${this.supervisorToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(`HA API ${res.status} fetching ${entityId}`);
    }
    const state = (await res.json()) as HAEntityState;
    this.allStates.set(entityId, state);
    return state;
  }

  async getDeviceRegistry(): Promise<any[]> {
    return this.sendCommand({ type: "config/device_registry/list" });
  }

  async getEntityRegistry(): Promise<any[]> {
    return this.sendCommand({ type: "config/entity_registry/list" });
  }

  async getAreaRegistry(): Promise<any[]> {
    return this.sendCommand({ type: "config/area_registry/list" });
  }

  /** Device, entity and area registries, cached briefly. */
  async getRegistries(): Promise<HARegistries> {
    if (this.registriesCache && Date.now() - this.registriesCache.at < REGISTRY_CACHE_MS) {
      return this.registriesCache.data;
    }
    const [devices, entities, areas] = await Promise.all([
      this.getDeviceRegistry(),
      this.getEntityRegistry(),
      this.getAreaRegistry(),
    ]);
    const data = { devices: devices || [], entities: entities || [], areas: areas || [] };
    this.registriesCache = { at: Date.now(), data };
    return data;
  }

  /** All services by domain (HA `get_services`), cached briefly. */
  async getServices(): Promise<Record<string, any>> {
    if (this.servicesCache && Date.now() - this.servicesCache.at < REGISTRY_CACHE_MS) {
      return this.servicesCache.data;
    }
    const data = (await this.sendCommand({ type: "get_services" })) || {};
    this.servicesCache = { at: Date.now(), data };
    return data;
  }

  async callService(
    domain: string,
    service: string,
    data?: Record<string, any>,
    target?: { entity_id?: string | string[]; device_id?: string | string[]; area_id?: string | string[] }
  ): Promise<any> {
    const msg: any = {
      type: "call_service",
      domain,
      service,
      service_data: data || {},
    };
    if (target) {
      msg.target = target;
    }
    return this.sendCommand(msg);
  }

  onStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeCallbacks.push(callback);
    return () => {
      const idx = this.stateChangeCallbacks.indexOf(callback);
      if (idx >= 0) this.stateChangeCallbacks.splice(idx, 1);
    };
  }

  async subscribeToEvent(eventType: string, callback: EventCallback): Promise<() => void> {
    const sub: ActiveEventSub = { eventType, callback, currentId: 0 };
    this.activeEventSubs.push(sub);
    await this.establishEventSub(sub);

    return () => {
      const idx = this.activeEventSubs.indexOf(sub);
      if (idx >= 0) this.activeEventSubs.splice(idx, 1);
      this.eventSubscriptions.delete(sub.currentId);
      // Tell HA too, otherwise it keeps sending events after every reload
      if (this.connected && sub.currentId > 0) {
        this.sendCommand({ type: "unsubscribe_events", subscription: sub.currentId }).catch(() => {});
      }
    };
  }

  private async establishEventSub(sub: ActiveEventSub): Promise<void> {
    const id = this.nextId();
    // Clean up old subscription entry if re-subscribing
    if (sub.currentId > 0) {
      this.eventSubscriptions.delete(sub.currentId);
    }
    sub.currentId = id;
    const msg = { id, type: "subscribe_events", event_type: sub.eventType };
    this.eventSubscriptions.set(id, sub.callback);

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error("Not connected"));
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  private async resubscribeActiveEvents(): Promise<void> {
    if (this.activeEventSubs.length === 0) return;
    this.logFn("info", "ha-client", `Re-subscribing ${this.activeEventSubs.length} event subscription(s)...`);
    for (const sub of this.activeEventSubs) {
      try {
        await this.establishEventSub(sub);
      } catch (err: any) {
        this.logFn("error", "ha-client", `Re-subscribe failed for ${sub.eventType}: ${err.message}`);
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.connected = false;
  }
}
