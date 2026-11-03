/**
 * Runs one test scenario inside an isolated worker: simulated clock, simulated
 * states, recorded service calls. Waits complete instantly unless the scenario
 * sends live calls with real-time waits.
 */

import * as FakeTimers from "@sinonjs/fake-timers";
import { AutomationManager } from "./automation-manager";
import { TestHost } from "./test-host";
import { TestExpectationResult, TestResult, TestRunSpec, TestStep } from "../shared/tests";

const realSetImmediate = setImmediate;
const realSetTimeout = setTimeout;
const REAL_TIME_TICK_MS = 250; //< clock step while a wait runs in real time
const SETTLE_ROUNDS = 6; //< let callbacks, their awaited calls and simulated effects finish
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const FAKED_TIMERS: FakeTimers.FakeMethod[] = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"];

export function formatDuration(seconds: number): string {
  if (seconds >= SECONDS_PER_HOUR && seconds % SECONDS_PER_HOUR === 0) return `${seconds / SECONDS_PER_HOUR}h`;
  if (seconds >= SECONDS_PER_MINUTE) {
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    const rest = seconds - minutes * SECONDS_PER_MINUTE;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

export function describeStep(step: TestStep): string {
  switch (step.type) {
    case "set":
      return `Set ${step.entityId} → ${step.state}${step.attributes && Object.keys(step.attributes).length ? " " + JSON.stringify(step.attributes) : ""}`;
    case "wait":
      return `Wait ${formatDuration(step.seconds)}`;
    case "event":
      return `Fire event ${step.eventType}`;
    case "expect_state":
      return `Expect ${step.entityId} is ${step.state}`;
    case "expect_service":
      return `Expect ${step.not ? "no " : ""}${step.service}${step.entityId ? " on " + step.entityId : ""}`;
  }
}

export interface TestRunInput {
  spec: TestRunSpec;
  host: TestHost;
  manager: AutomationManager;
  /** Load index.ts and run onInit(); returns an error message on failure. */
  loadAutomations: () => Promise<string | undefined>;
}

export async function runTestScenario({ spec, host, manager, loadAutomations }: TestRunInput): Promise<Omit<TestResult, "realMs" | "ranAt">> {
  const { scenario } = spec;
  const clock = FakeTimers.install({ now: spec.startTimeMs, toFake: FAKED_TIMERS });
  const realTime = host.live && !!scenario.realTimeWaits;
  const settle = async () => {
    for (let iRound = 0; iRound < SETTLE_ROUNDS; iRound++) {
      await clock.tickAsync(0);
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      await host.waitForLiveCalls();
    }
  };
  const waitFor = async (totalMs: number) => {
    if (!realTime) {
      await clock.tickAsync(totalMs);
      return;
    }
    let remainingMs = totalMs;
    while (remainingMs > 0) {
      const chunkMs = Math.min(REAL_TIME_TICK_MS, remainingMs);
      await new Promise<void>((resolve) => realSetTimeout(resolve, chunkMs));
      await clock.tickAsync(chunkMs);
      remainingMs -= chunkMs;
    }
  };

  // Automations must not reach the network from a test
  (globalThis as any).fetch = async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as any)?.url ?? String(input);
    host.add("network", `Blocked network request: ${url}`);
    throw new Error("Network access is disabled in TAE tests");
  };

  host.add("info", `Simulated start: ${new Date().toString()}`);
  if (host.live) {
    host.add("info", `Service calls are sent to Home Assistant${realTime ? "; waits take real time" : ""}`);
  }
  const loadError = await loadAutomations();
  await settle();

  const automations = manager.getAutomations().map((automation) => ({
    id: automation.id,
    started: automation.state === "running",
    state: automation.state,
  }));
  const started = automations.filter((automation) => automation.started).map((automation) => automation.id);
  const skippedCount = automations.length - started.length;
  host.add(
    "info",
    (started.length ? `Running: ${started.join(", ")}` : "No automation is running in this test") +
      (skippedCount ? ` (${skippedCount} other automation${skippedCount === 1 ? "" : "s"} not started)` : "")
  );

  const expectations: TestExpectationResult[] = [];
  let serviceMark = 0;
  if (!loadError) {
    for (let iStep = 0; iStep < scenario.steps.length; iStep++) {
      const step = scenario.steps[iStep];
      host.setCurrentStep(iStep);
      switch (step.type) {
        case "set": {
          host.add("step", describeStep(step));
          host.setState(step.entityId, step.state, step.attributes);
          await settle();
          break;
        }
        case "wait": {
          host.add("step", describeStep(step));
          await waitFor(Math.max(0, step.seconds) * MS_PER_SECOND);
          await settle();
          break;
        }
        case "event": {
          const delivered = host.fireEvent(step.eventType, step.data || {});
          host.add("step", `${describeStep(step)} (${delivered} subscriber${delivered === 1 ? "" : "s"})`, { detail: step.data });
          await settle();
          break;
        }
        case "expect_state": {
          const actual = host.states.get(step.entityId)?.state;
          const passed = actual === step.state;
          const message = passed
            ? `${step.entityId} is ${step.state}`
            : `${step.entityId} is ${actual === undefined ? "missing" : actual}, expected ${step.state}`;
          expectations.push({ step: iStep, passed, message });
          host.add("expect", message, { passed });
          break;
        }
        case "expect_service": {
          const matching = host.calls
            .slice(serviceMark)
            .filter((call) => `${call.domain}.${call.service}` === step.service && (!step.entityId || call.entityIds.includes(step.entityId)));
          serviceMark = host.calls.length;
          const target = `${step.service}${step.entityId ? " on " + step.entityId : ""}`;
          const passed = step.not ? matching.length === 0 : matching.length > 0;
          const message = step.not
            ? passed
              ? `${target} was not called`
              : `${target} was called ${matching.length}× (expected none)`
            : passed
              ? `${target} was called${matching.length > 1 ? ` ${matching.length}×` : ""}`
              : `${target} was not called`;
          expectations.push({ step: iStep, passed, message });
          host.add("expect", message, { passed });
          break;
        }
      }
    }
  }
  host.setCurrentStep(undefined);

  const errors = host.items.filter((item) => item.kind === "error").length;
  const passed = !loadError && expectations.every((expectation) => expectation.passed);
  if (errors > 0) host.add("info", `${errors} error(s) were logged during the run`);
  const simulatedMs = host.now();
  clock.uninstall();

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    passed,
    ...(loadError ? { error: loadError } : {}),
    simulatedMs,
    items: host.items,
    expectations,
    serviceCalls: host.calls.length,
    ...(host.live ? { liveCalls: host.liveCallCount } : {}),
    automations,
  };
}
