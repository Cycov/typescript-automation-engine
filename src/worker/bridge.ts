/**
 * Worker Bridge — communication layer between worker thread and main process.
 *
 * Provides promise-based request/response over parentPort,
 * and event forwarding from main to registered callbacks.
 */

import { parentPort } from "worker_threads";
import { MainToWorkerMessage, WorkerToMainMessage } from "../shared/messages";

type EventHandler = (data: any) => void;
type StateChangeHandler = (entityId: string, oldState: any, newState: any) => void;

export class Bridge {
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private eventHandlers = new Map<string, EventHandler>(); // subId → handler
  private stateChangeHandlers = new Map<string, StateChangeHandler>(); // subId → handler
  private commandHandlers = new Map<string, (automationId: string) => void>();
  private shutdownHandler?: () => void;

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

      case "stateChange": {
        const scHandler = this.stateChangeHandlers.get(msg.subId);
        if (scHandler) {
          try {
            scHandler(msg.entityId, msg.oldState, msg.newState);
          } catch (e: any) {
            this.sendLog("error", "bridge", `State change handler error: ${e.message}`, { stack: e.stack });
          }
        }
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
        this.shutdownHandler?.();
        break;
      }
    }
  }

  /**
   * Send a request to main and wait for response.
   */
  request(method: string, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ type: "request", id, method, args });

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  /**
   * Register a handler for subscription events.
   */
  onEvent(subId: string, handler: EventHandler): void {
    this.eventHandlers.set(subId, handler);
  }

  /**
   * Register a handler for state change events.
   */
  onStateChange(subId: string, handler: StateChangeHandler): void {
    this.stateChangeHandlers.set(subId, handler);
  }

  /**
   * Remove event/state handler.
   */
  removeHandler(subId: string): void {
    this.eventHandlers.delete(subId);
    this.stateChangeHandlers.delete(subId);
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
  onShutdown(handler: () => void): void {
    this.shutdownHandler = handler;
  }

  /**
   * Send a log message to main.
   */
  sendLog(level: string, automationId: string, message: any, extra?: any): void {
    // Serialize objects before sending over the message port
    let formattedMessage: string;
    if (typeof message === "string") {
      formattedMessage = message;
    } else if (message === null || message === undefined) {
      formattedMessage = String(message);
    } else if (typeof message === "object") {
      try {
        formattedMessage = JSON.stringify(message, null, 2);
      } catch {
        formattedMessage = String(message);
      }
    } else {
      formattedMessage = String(message);
    }
    this.send({ type: "log", level, automationId, message: formattedMessage, extra });
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
   * Notify main of automation removal.
   */
  sendAutomationRemoved(id: string): void {
    this.send({ type: "automationRemoved", id });
  }

  /**
   * Notify main that init is complete.
   */
  sendInitComplete(automations: Array<{ id: string; className: string; state: string }>): void {
    this.send({
      type: "initComplete",
      automations: automations.map((a) => ({
        id: a.id,
        className: a.className,
        state: a.state as any,
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

  private send(msg: WorkerToMainMessage): void {
    parentPort?.postMessage(msg);
  }
}
