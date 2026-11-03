// ─── Test scenarios: run automations against simulated states ───

export interface TestStateEntry {
  entityId: string;
  state: string;
  attributes?: Record<string, any>;
}

export type TestStep =
  | { type: "set"; entityId: string; state: string; attributes?: Record<string, any> }
  | { type: "wait"; seconds: number }
  | { type: "event"; eventType: string; data?: Record<string, any> }
  | { type: "expect_state"; entityId: string; state: string }
  | { type: "expect_service"; service: string; entityId?: string; not?: boolean };

export interface TestScenario {
  id: string;
  name: string;
  /** Workspace file the scenario belongs to ("" = not tied to a file). */
  file: string;
  /** Automation ids to start; empty = all. */
  automations: string[];
  /** "HH:MM" simulated start time today; empty = now. */
  startTime: string;
  /** Service calls change simulated states (light.turn_on → on, ...). */
  applyEffects: boolean;
  /** Service calls are also sent to Home Assistant, so real devices react. */
  liveCalls?: boolean;
  /** With liveCalls: waits take real time instead of finishing instantly. */
  realTimeWaits?: boolean;
  initial: TestStateEntry[];
  steps: TestStep[];
  updatedAt?: number;
}

export type TestTimelineKind = "step" | "service" | "effect" | "log" | "error" | "expect" | "network" | "info";

export interface TestTimelineItem {
  at: number; //< simulated ms since the scenario started
  kind: TestTimelineKind;
  text: string;
  automationId?: string;
  level?: string;
  step?: number; //< 0-based step index
  passed?: boolean;
  detail?: any;
  live?: boolean; //< service call that was sent to Home Assistant
}

export interface TestExpectationResult {
  step: number;
  passed: boolean;
  message: string;
}

export interface TestResult {
  scenarioId: string;
  name: string;
  passed: boolean;
  /** Set when the scenario could not run (load failure, timeout). */
  error?: string;
  ranAt: string;
  realMs: number;
  simulatedMs: number;
  items: TestTimelineItem[];
  expectations: TestExpectationResult[];
  serviceCalls: number;
  /** Service calls sent to Home Assistant (liveCalls). */
  liveCalls?: number;
  automations: Array<{ id: string; started: boolean; state: string }>;
}

/** Handed to a test worker inside workerData. */
export interface TestRunSpec {
  scenario: TestScenario;
  startTimeMs: number;
  /** Copy of persistent storage; writes stay inside the test. */
  storage: Record<string, Record<string, any>>;
  /** Send service calls to Home Assistant (the scenario's liveCalls, unless the run forces a simulation). */
  liveCalls: boolean;
}
