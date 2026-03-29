/**
 * Home Assistant WebSocket Client
 *
 * Connects to HA via WebSocket, manages authentication, state caching,
 * and provides API for calling services and subscribing to events.
 */

import WebSocket from "ws";
import { HAEntityState, HAEvent } from "../shared/messages";

type StateChangeCallback = (data: {
  entity_id: string;
  old_state: HAEntityState | null;
  new_state: HAEntityState | null;
}) => void;

type EventCallback = (event: HAEvent) => void;

export class HAClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private eventSubscriptions = new Map<number, EventCallback>();
  private stateChangeCallbacks: StateChangeCallback[] = [];
  private activeEventSubs: Array<{ eventType: string; callback: EventCallback; currentId: number }> = [];
  private allStates = new Map<string, HAEntityState>();
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private supervisorToken: string;
  private wsUrl: string;
  private onConnectCb?: () => void;
  private logFn: (level: string, source: string, message: string, extra?: any) => void;

  constructor(options: {
    supervisorToken: string;
    logFn: (level: string, source: string, message: string, extra?: any) => void;
    onConnect?: () => void;
  }) {
    this.supervisorToken = options.supervisorToken;
    this.wsUrl = "ws://supervisor/core/websocket";
    this.logFn = options.logFn;
    this.onConnectCb = options.onConnect;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logFn("info", "ha-client", "Connecting to Home Assistant WebSocket...");

      this.ws = new WebSocket(this.wsUrl);

      this.ws.on("open", () => {
        this.logFn("info", "ha-client", "WebSocket connection opened");
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.type === "auth_required") {
          this.ws!.send(JSON.stringify({ type: "auth", access_token: this.supervisorToken }));
          return;
        }

        if (msg.type === "auth_ok") {
          this.connected = true;
          this.logFn("info", "ha-client", "Authenticated with Home Assistant");
          this.fetchAllStates()
            .then(() => this.subscribeToAllEvents())
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
          const { resolve, reject } = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.success === false) {
            reject(new Error(msg.error?.message || "Request failed"));
          } else {
            resolve(msg.result);
          }
          return;
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.logFn("warn", "ha-client", "WebSocket closed, reconnecting in 5s...");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err: Error) => {
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
      } catch (e: any) {
        this.logFn("error", "ha-client", `Reconnect failed: ${e.message}`);
        this.scheduleReconnect();
      }
    }, 5000);
  }

  private nextId(): number {
    return ++this.msgId;
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
          reject(new Error(`Request ${id} timed out`));
        }
      }, 30000);
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

  private async subscribeToAllEvents(): Promise<void> {
    const id = this.nextId();
    const msg = { id, type: "subscribe_events" };

    this.eventSubscriptions.set(id, (event: HAEvent) => {
      if (event.event_type === "state_changed") {
        const entityId = event.data.entity_id;
        if (event.data.new_state) {
          this.allStates.set(entityId, event.data.new_state);
        }
        for (const cb of this.stateChangeCallbacks) {
          try {
            cb({
              entity_id: entityId,
              old_state: event.data.old_state,
              new_state: event.data.new_state,
            });
          } catch (e: any) {
            this.logFn("error", "ha-client", `State change callback error: ${e.message}`, {
              stack: e.stack,
            });
          }
        }
      }
    });

    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("Not connected"));
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  getEntityState(entityId: string): HAEntityState | undefined {
    return this.allStates.get(entityId);
  }

  getAllStates(): HAEntityState[] {
    return Array.from(this.allStates.values());
  }

  async fetchEntityState(entityId: string): Promise<HAEntityState | undefined> {
    const states: HAEntityState[] = await this.sendCommand({ type: "get_states" });
    for (const s of states) {
      this.allStates.set(s.entity_id, s);
    }
    return this.allStates.get(entityId);
  }

  async callService(
    domain: string,
    service: string,
    data?: Record<string, any>,
    target?: { entity_id?: string | string[] }
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
    const sub = { eventType, callback, currentId: 0 };
    this.activeEventSubs.push(sub);
    await this.establishEventSub(sub);

    return () => {
      this.eventSubscriptions.delete(sub.currentId);
      const idx = this.activeEventSubs.indexOf(sub);
      if (idx >= 0) this.activeEventSubs.splice(idx, 1);
    };
  }

  private async establishEventSub(sub: { eventType: string; callback: EventCallback; currentId: number }): Promise<void> {
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
      } catch (e: any) {
        this.logFn("error", "ha-client", `Re-subscribe failed for ${sub.eventType}: ${e.message}`);
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
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
