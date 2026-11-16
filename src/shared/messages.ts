// ─── Message protocol between main process and worker thread ───

import { TestResult, TestRunSpec } from "./tests";

export type ShutdownReason = "reload" | "stop";

// ─── Automation timeline (traces) ───

export interface TraceTrigger {
  kind: "start" | "state" | "event" | "timer";
  entityId?: string;
  from?: string | null;
  to?: string | null;
  eventType?: string;
  /** Timer: delay and what scheduled it. */
  delayMs?: number;
  interval?: boolean;
  parent?: string;
}

export type TraceAction =
  | { kind: "service"; at: number; domain: string; service: string; data?: any; error?: string }
  | { kind: "log"; at: number; level: string; message: string }
  | { kind: "error"; at: number; message: string };

export interface TraceInfo {
  id: string;
  automationId: string;
  startedAt: number; //< epoch ms
  trigger: TraceTrigger;
  actions: TraceAction[]; //< `at` is ms since startedAt
  durationMs?: number; //< set when the callback finished
  error?: string;
  truncated?: boolean;
}

// Main → Worker
export type MainToWorkerMessage =
  | { type: "init"; config: WorkerConfig }
  | { type: "response"; id: number; result?: any; error?: string }
  | { type: "event"; subId: string; data: any }
  | { type: "stateChanged"; entityId: string; oldState: HAEntityState | null; newState: HAEntityState | null }
  | { type: "stateSnapshot"; states: HAEntityState[] }
  | { type: "secrets"; secrets: Record<string, string> }
  | { type: "command"; command: "stopAutomation" | "startAutomation"; automationId: string }
  | { type: "shutdown"; reason: ShutdownReason };

// Worker → Main
export type WorkerToMainMessage =
  | { type: "request"; id: number; method: string; args: any }
  | { type: "log"; level: string; automationId: string; message: string; extra?: any }
  | { type: "automationRegistered"; automation: AutomationInfo }
  | { type: "automationStateChanged"; id: string; state: AutomationState; error?: string }
  | { type: "automationError"; id: string; error: string; at: string }
  | { type: "automationRemoved"; id: string }
  | { type: "ready" }
  | { type: "initComplete"; automations: AutomationInfo[] }
  | { type: "error"; message: string; stack?: string }
  | { type: "trace"; trace: TraceInfo }
  | { type: "traceIgnored"; automationId: string; at: number; trigger: TraceTrigger }
  | { type: "testResult"; result: TestResult };

export interface WorkerConfig {
  automationsPath: string;
  logLevel: string;
}

/** Data handed to a new worker thread via `workerData`. */
export interface WorkerData {
  config: WorkerConfig;
  states: HAEntityState[];
  /** Secrets from the Secrets tab, for getSecret(). */
  secrets?: Record<string, string>;
  /** Present for a test run: isolated, simulated clock, no Home Assistant access. */
  test?: TestRunSpec;
}

export type AutomationState = "running" | "stopped" | "error" | "deleted";

export interface AutomationInfo {
  id: string;
  className: string;
  state: AutomationState;
  error?: string;
  /** Last error thrown by a callback while the automation kept running. */
  lastError?: string;
  lastErrorAt?: string;
  errorCount?: number;
}

export interface HAEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
  context: { id: string; parent_id: string | null; user_id: string | null };
}

export interface HAEvent {
  event_type: string;
  data: Record<string, any>;
  origin: string;
  time_fired: string;
  context: { id: string; parent_id: string | null; user_id: string | null };
}
