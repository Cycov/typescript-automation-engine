/**
 * Worker Bridge — communication layer between worker thread and main process.
 *
 * Provides promise-based request/response over parentPort,
 * and event forwarding from main to registered callbacks.
 */

import { parentPort } from "worker_threads";
import {
  HAEntityState,
  MainToWorkerMessage,
  ShutdownReason,
  TraceInfo,
  TraceTrigger,
  WorkerToMainMessage,
} from "../shared/messages";

const REQUEST_TIMEOUT_MS = 30000;
const nativeSetTimeout = setTimeout; //< captured before automations can wrap the timer functions
const nativeClearTimeout = clearTimeout;

export type EventHandler = (data: any) => void;
export type StateChangedHandler = (entityId: string, oldState: HAEntityState | null, newState: HAEntityState | null) => void;
export type StateSnapshotHandler = (states: HAEntityState[]) => void;

/** What the automation manager needs from its environment: the main thread, or a test simulation. */
export interface WorkerHost {
  request(method: string, args: any, timeoutMs?: number): Promise<any>;
  onEvent(subId: string, handler: EventHandler): void;
  removeHandler(subId: string): void;
  onStateChanged(handler: StateChangedHandler): void;
  onStateSnapshot(handler: StateSnapshotHandler): void;
  sendLog(level: string, automationId: string, message: any, extra?: any): void;
  sendAutomationRegistered(automation: { id: string; className: string; state: string }): void;
  sendAutomationStateChanged(id: string, state: string, error?: string): void;
  sendAutomationError(id: string, error: string): void;
  sendError(message: string, stack?: string): void;
  sendTrace(trace: TraceInfo): void;
  sendTraceIgnored(automationId: string, at: number, trigger: TraceTrigger): void;
}

/** Turn a log message into the string sent to the log. */
export function formatLogMessage(message: any): string {
  if (typeof message === "string") return message;
  if (message === null || message === undefined) return String(message);
  if (typeof message === "object") {
    try {
      return JSON.stringify(message, null, 2);
    } catch {
      return String(message);
    }
  }
  return String(message);
}

export class Bridge implements WorkerHost {
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>();
  private eventHandlers = new Map<string, EventHandler>(); // subId → handler
  private stateChangedHandler?: StateChangedHandler;
  private stateSnapshotHandler?: StateSnapshotHandler;
  private secretsHandler?: (secrets: Record<string, string>) => void;
  private commandHandlers = new Map<string, (automationId: string) => void>();
  private shutdownHandler?: (reason: ShutdownReason) => void;

  constructor() {
    if (!parentPort) {
      throw new Error("Bridge must be created inside a worker thread");
    }

    parentPort.on("message", (msg: MainToWorkerMessage) => {
      this.handleMessage(msg);
    });
  }

  private handleMessage(msg: MainToWorkerMessage): void {
    switch (msg.type) {
      case "response": {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          nativeClearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
        break;
      }

      case "event": {
        const handler = this.eventHandlers.get(msg.subId);
        if (handler) {
          try {
            handler(msg.data);
          } catch (e: any) {
            this.sendLog("error", "bridge", `Event handler error: ${e.message}`, { stack: e.stack });
          }
        }
        break;
      }

      case "stateChanged": {
        try {
          this.stateChangedHandler?.(msg.entityId, msg.oldState, msg.newState);
        } catch (e: any) {
          this.sendLog("error", "bridge", `State change handler error: ${e.message}`, { stack: e.stack });
        }
        break;
      }

      case "stateSnapshot": {
        this.stateSnapshotHandler?.(msg.states);
        break;
      }

      case "secrets": {
        this.secretsHandler?.(msg.secrets);
        break;
      }

      case "command": {
        const cmdHandler = this.commandHandlers.get(msg.command);
        if (cmdHandler) {
          cmdHandler(msg.automationId);
        }
        break;
      }

      case "shutdown": {
        this.shutdownHandler?.(msg.reason);
        break;
      }
    }
  }

  /**
   * Send a request to main and wait for response.
   */
  request(method: string, args: any, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      this.requestId++;
      const id = this.requestId;
      const timer = nativeSetTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send({ type: "request", id, method, args });
    });
  }

  /**
   * Register a handler for subscription events.
   */
  onEvent(subId: string, handler: EventHandler): void {
    this.eventHandlers.set(subId, handler);
  }

  /**
   * Register the handler for every HA state change (one per worker).
   */
  onStateChanged(handler: StateChangedHandler): void {
    this.stateChangedHandler = handler;
  }

  /**
   * Register the handler for full state refreshes (sent after an HA reconnect).
   */
  onStateSnapshot(handler: StateSnapshotHandler): void {
    this.stateSnapshotHandler = handler;
  }

  /** Register the handler for secrets changed in the Secrets tab. */
  onSecrets(handler: (secrets: Record<string, string>) => void): void {
    this.secretsHandler = handler;
  }

  /**
   * Remove an event handler.
   */
  removeHandler(subId: string): void {
    this.eventHandlers.delete(subId);
  }

  /**
   * Register command handlers.
   */
  onCommand(command: string, handler: (automationId: string) => void): void {
    this.commandHandlers.set(command, handler);
  }

  /**
   * Register shutdown handler.
   */
  onShutdown(handler: (reason: ShutdownReason) => void): void {
    this.shutdownHandler = handler;
  }

  /**
   * Send a log message to main.
   */
  sendLog(level: string, automationId: string, message: any, extra?: any): void {
    this.send({ type: "log", level, automationId, message: formatLogMessage(message), extra });
  }

  /**
   * Notify main that an automation was registered.
   */
  sendAutomationRegistered(automation: { id: string; className: string; state: string }): void {
    this.send({
      type: "automationRegistered",
      automation: {
        id: automation.id,
        className: automation.className,
        state: automation.state as any,
      },
    });
  }

  /**
   * Notify main of automation state change.
   */
  sendAutomationStateChanged(id: string, state: string, error?: string): void {
    this.send({ type: "automationStateChanged", id, state: state as any, error });
  }

  /**
   * Report a callback error; the automation keeps running.
   */
  sendAutomationError(id: string, error: string): void {
    this.send({ type: "automationError", id, error, at: new Date().toISOString() });
  }

  /**
   * Notify main of automation removal.
   */
  sendAutomationRemoved(id: string): void {
    this.send({ type: "automationRemoved", id });
  }

  /**
   * Notify main that init is complete.
   */
  sendInitComplete(automations: Array<{ id: string; className: string; state: string; error?: string }>): void {
    this.send({
      type: "initComplete",
      automations: automations.map((a) => ({
        id: a.id,
        className: a.className,
        state: a.state as any,
        error: a.error,
      })),
    });
  }

  /**
   * Notify main that worker is ready.
   */
  sendReady(): void {
    this.send({ type: "ready" });
  }

  /**
   * Send error to main.
   */
  sendError(message: string, stack?: string): void {
    this.send({ type: "error", message, stack });
  }

  sendTrace(trace: TraceInfo): void {
    this.send({ type: "trace", trace });
  }

  sendTraceIgnored(automationId: string, at: number, trigger: TraceTrigger): void {
    this.send({ type: "traceIgnored", automationId, at, trigger });
  }

  /** Post any message to main (test results). */
  post(msg: WorkerToMainMessage): void {
    this.send(msg);
  }

  private send(msg: WorkerToMainMessage): void {
    parentPort?.postMessage(msg);
  }
}
