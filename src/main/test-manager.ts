/**
 * Test scenarios — saved per file, run one at a time in an isolated worker
 * (simulated states and clock; service calls are recorded, and only sent to
 * Home Assistant when the scenario asks for live calls).
 */

import { Worker } from "worker_threads";
import * as crypto from "crypto";
import * as path from "path";
import { z } from "zod";
import { HAClient } from "./ha-client";
import { Storage } from "./storage";
import { Logger } from "./logging";
import type { AIGenerator } from "./worker-manager";
import { HAEntityState, MainToWorkerMessage, WorkerConfig, WorkerData, WorkerToMainMessage } from "../shared/messages";
import { TestResult, TestScenario } from "../shared/tests";

const TEST_TIMEOUT_MS = 60_000; //< on top of real-time waits
const MS_PER_SECOND = 1000;
const ID_BYTES = 6;
const MAX_WAIT_SECONDS = 7 * 24 * 3600;
const START_TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

const entityIdSchema = z.string().regex(/^[a-z_0-9]+\.[a-zA-Z0-9_]+$/, "entity id like light.kitchen");
const attributesSchema = z.record(z.string(), z.any()).optional();

const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set"), entityId: entityIdSchema, state: z.string(), attributes: attributesSchema }),
  z.object({ type: z.literal("wait"), seconds: z.number().min(0).max(MAX_WAIT_SECONDS) }),
  z.object({ type: z.literal("event"), eventType: z.string().min(1), data: z.record(z.string(), z.any()).optional() }),
  z.object({
    type: z.literal("expect_state"),
    entityId: entityIdSchema,
    state: z.string(),
    attributes: attributesSchema.describe("These attributes must match (the entity may have more)"),
  }),
  z.object({
    type: z.literal("expect_service"),
    service: z.string().regex(/^[a-z_0-9]+\.[a-z_0-9]+$/, "service like light.turn_on"),
    entityId: entityIdSchema.optional(),
    data: z.record(z.string(), z.any()).optional().describe("The call's data must contain these values, e.g. { message: 'clear_notification' }"),
    count: z.number().int().min(0).optional().describe("Exactly this many matching calls since the previous expect_service"),
    not: z.boolean().optional(),
  }),
  z.object({ type: z.literal("restart") }).describe("TAE restarts: automations stop and load again; persistent storage, states and published entities stay"),
]);

export const testScenarioSchema = z.object({
  id: z.string().optional().describe("Omit to create a new scenario"),
  name: z.string().min(1),
  file: z.string().default("").describe("Workspace file the scenario belongs to, e.g. 'activity-detection/movement-sensors.ts'"),
  automations: z.array(z.string()).default([]).describe("Automation ids to start; empty = all"),
  startTime: z.string().default("").describe("Simulated time of day 'HH:MM'; empty = now"),
  applyEffects: z.boolean().default(true).describe("Service calls change the simulated states (light.turn_on → on, ...)"),
  liveCalls: z
    .boolean()
    .default(false)
    .describe("Also send service calls to Home Assistant so real devices react. Only when run from the Tests tab; run_test always simulates"),
  realTimeWaits: z.boolean().default(false).describe("With liveCalls: waits take real time instead of finishing instantly"),
  initial: z
    .array(z.object({ entityId: entityIdSchema, state: z.string(), attributes: attributesSchema }))
    .default([])
    .describe("Entity states before the automations start (others keep their current real state)"),
  storage: z
    .record(z.string(), z.record(z.string(), z.any()))
    .optional()
    .describe("Persistent storage before the run, per automation id: { AutomationId: { key: value } }. Listed automations start with exactly these values; others get a copy of their real storage"),
  steps: z.array(stepSchema).default([]),
});

export type TestScenarioInput = z.input<typeof testScenarioSchema>;

export interface TestScenarioEntry {
  scenario: TestScenario;
  lastResult: TestResult | null;
}

export interface TestRunOptions {
  /** Record service calls only, even when the scenario has liveCalls. */
  simulateOnly?: boolean;
}

export type TestRunEvent =
  | { type: "started"; scenarioId: string }
  | { type: "finished"; scenarioId: string; result: TestResult };

function startTimeToday(startTime: string): number {
  if (!startTime || !START_TIME_PATTERN.test(startTime)) return Date.now();
  const [hours, minutes] = startTime.split(":").map(Number);
  const start = new Date();
  start.setHours(hours, minutes, 0, 0);
  return start.getTime();
}

/** Real states with the scenario's initial values on top. */
function initialStates(real: HAEntityState[], scenario: TestScenario, startTimeMs: number): HAEntityState[] {
  const byId = new Map(real.map((state) => [state.entity_id, state]));
  const timestamp = new Date(startTimeMs).toISOString();
  for (const entry of scenario.initial) {
    const before = byId.get(entry.entityId);
    byId.set(entry.entityId, {
      entity_id: entry.entityId,
      state: entry.state,
      attributes: { ...(before?.attributes || {}), ...(entry.attributes || {}) },
      last_changed: timestamp,
      last_updated: timestamp,
      context: { id: "test", parent_id: null, user_id: null },
    });
  }
  return Array.from(byId.values());
}

export class TestManager {
  private haClient: HAClient;
  private storage: Storage;
  private logger: Logger;
  private config: WorkerConfig;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners: ((event: TestRunEvent) => void)[] = [];
  private current: { scenarioId: string; stop: () => void } | null = null;

  private aiGenerator?: AIGenerator;

  constructor(haClient: HAClient, storage: Storage, logger: Logger, config: WorkerConfig) {
    this.haClient = haClient;
    this.storage = storage;
    this.logger = logger;
    this.config = config;
  }

  /** Live runs answer this.ai.generate with the real AI. */
  setAIGenerator(generator: AIGenerator): void {
    this.aiGenerator = generator;
  }

  onRun(listener: (event: TestRunEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  list(): TestScenarioEntry[] {
    return this.storage.listTestScenarios();
  }

  get(id: string): TestScenarioEntry | undefined {
    return this.storage.getTestScenario(id);
  }

  /** Validate and save; returns the stored scenario (with its id). */
  save(input: unknown): TestScenario {
    const parsed = testScenarioSchema.parse(input);
    if (parsed.startTime && !START_TIME_PATTERN.test(parsed.startTime)) {
      throw new Error(`startTime must be HH:MM, got "${parsed.startTime}"`);
    }
    const scenario: TestScenario = {
      ...parsed,
      id: parsed.id || crypto.randomBytes(ID_BYTES).toString("hex"),
      updatedAt: Date.now(),
    };
    this.storage.saveTestScenario(scenario.id, scenario);
    return scenario;
  }

  delete(id: string): void {
    this.storage.deleteTestScenario(id);
  }

  /** Run a saved scenario (or an unsaved one passed in full). Runs are queued. */
  run(idOrScenario: string | TestScenario, options: TestRunOptions = {}): Promise<TestResult> {
    const job = this.queue.then(() => this.runNow(idOrScenario, options));
    this.queue = job.catch(() => {});
    return job;
  }

  /** Stop the scenario if it is the one running. */
  stop(id: string): void {
    if (this.current?.scenarioId === id) this.current.stop();
  }

  private async runNow(idOrScenario: string | TestScenario, options: TestRunOptions): Promise<TestResult> {
    let scenario: TestScenario;
    if (typeof idOrScenario === "string") {
      const entry = this.get(idOrScenario);
      if (!entry) throw new Error(`No test scenario with id ${idOrScenario}`);
      scenario = entry.scenario;
    } else {
      scenario = idOrScenario;
    }
    this.emit({ type: "started", scenarioId: scenario.id });
    const liveCalls = !!scenario.liveCalls && !options.simulateOnly;
    if (liveCalls) this.logger.log("info", "tests", `Test "${scenario.name}" sends its service calls to Home Assistant`);
    const result = await this.spawn(scenario, liveCalls);
    if (this.get(scenario.id)) this.storage.saveTestResult(scenario.id, result);
    this.logger.log(
      result.passed ? "info" : "warn",
      "tests",
      `Test "${scenario.name}": ${result.passed ? "passed" : result.error || "failed"} (${result.expectations.filter((item) => item.passed).length}/${result.expectations.length} checks)`
    );
    this.emit({ type: "finished", scenarioId: scenario.id, result });
    return result;
  }

  private spawn(scenario: TestScenario, liveCalls: boolean): Promise<TestResult> {
    const startTimeMs = startTimeToday(scenario.startTime);
    const workerData: WorkerData = {
      config: this.config,
      states: initialStates(this.haClient.getAllStates(), scenario, startTimeMs),
      test: { scenario, startTimeMs, storage: { ...this.storage.getAllPersistent(), ...(scenario.storage ?? {}) }, liveCalls },
    };
    const realWaitMs = liveCalls && scenario.realTimeWaits
      ? scenario.steps.reduce((total, step) => total + (step.type === "wait" ? step.seconds * MS_PER_SECOND : 0), 0)
      : 0;
    const timeoutMs = TEST_TIMEOUT_MS + realWaitMs;
    const startedAt = Date.now();
    const failed = (error: string): TestResult => ({
      scenarioId: scenario.id,
      name: scenario.name,
      passed: false,
      error,
      ranAt: new Date(startedAt).toISOString(),
      realMs: Date.now() - startedAt,
      simulatedMs: 0,
      items: [],
      expectations: [],
      serviceCalls: 0,
      automations: [],
    });

    return new Promise((resolve) => {
      let settled = false;
      const worker = new Worker(path.join(__dirname, "..", "worker", "index.js"), { workerData });
      const finish = (result: TestResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.current = null;
        worker.terminate().catch(() => {});
        resolve(result);
      };
      const timer = setTimeout(() => finish(failed(`Timed out after ${Math.round(timeoutMs / MS_PER_SECOND)}s (an endless loop in the automation code?)`)), timeoutMs);
      this.current = { scenarioId: scenario.id, stop: () => finish(failed("Stopped")) };
      worker.on("message", (msg: WorkerToMainMessage) => {
        if (msg.type === "testResult") finish(msg.result);
        else if (msg.type === "request") this.answerRequest(worker, msg.id, msg.method, msg.args, liveCalls, scenario.name);
      });
      worker.on("error", (err) => finish(failed(`Test worker crashed: ${err.message}`)));
      worker.on("exit", (code) => finish(failed(`Test worker exited (code ${code}) before finishing`)));
    });
  }

  /** A test worker only asks the main thread for live service calls and AI text. */
  private async answerRequest(worker: Worker, id: number, method: string, args: any, liveCalls: boolean, testName: string): Promise<void> {
    const reply = (msg: MainToWorkerMessage) => {
      try { worker.postMessage(msg); } catch {} //< the worker may be gone already
    };
    const allowed = method === "callService" || (method === "aiGenerate" && !!this.aiGenerator);
    if (!allowed || !liveCalls) {
      reply({ type: "response", id, error: `${method} is not available in tests` });
      return;
    }
    try {
      if (method === "aiGenerate") {
        reply({ type: "response", id, result: await this.aiGenerator!(args) });
        return;
      }
      const target = args.data?.entity_id ?? args.data?.target?.entity_id;
      this.logger.log("info", "tests", `Test "${testName}": ${args.domain}.${args.service}${target ? " → " + [].concat(target).join(", ") : ""}`);
      const result = await this.haClient.callService(args.domain, args.service, args.data, undefined, { returnResponse: !!args.returnResponse });
      reply({ type: "response", id, result });
    } catch (err: any) {
      reply({ type: "response", id, error: err?.message ?? String(err) });
    }
  }

  private emit(event: TestRunEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }
}
