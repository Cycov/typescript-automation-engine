// ─── Message protocol between main process and worker thread ───

// Main → Worker
export type MainToWorkerMessage =
  | { type: "init"; config: WorkerConfig }
  | { type: "response"; id: number; result?: any; error?: string }
  | { type: "event"; subId: string; data: any }
  | { type: "stateChange"; subId: string; entityId: string; oldState: any; newState: any }
  | { type: "command"; command: "stopAutomation" | "startAutomation"; automationId: string }
  | { type: "shutdown" };

// Worker → Main
export type WorkerToMainMessage =
  | { type: "request"; id: number; method: string; args: any }
  | { type: "log"; level: string; automationId: string; message: string; extra?: any }
  | { type: "automationRegistered"; automation: AutomationInfo }
  | { type: "automationStateChanged"; id: string; state: AutomationState; error?: string }
  | { type: "automationRemoved"; id: string }
  | { type: "ready" }
  | { type: "initComplete"; automations: AutomationInfo[] }
  | { type: "error"; message: string; stack?: string };

export interface WorkerConfig {
  automationsPath: string;
  logLevel: string;
}

export type AutomationState = "running" | "stopped" | "error" | "deleted";

export interface AutomationInfo {
  id: string;
  className: string;
  state: AutomationState;
  error?: string;
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
