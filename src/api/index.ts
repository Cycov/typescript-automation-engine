/**
 * TAE — TypeScript Automation Engine API
 *
 * This is the main entry point for the `tae` module.
 * Automations import from this module:
 *
 *   import { Automation, registerAutomation, startAutomation } from 'tae';
 */

// Re-export base class
export { Automation } from "./automation";

// Re-export types
export {
  HAEntityState,
  HAEvent,
  StateChangeData,
  AutomationState,
  EventCallback,
  StateChangeCallback,
  UnsubscribeFunction,
  PersistentStorage,
  TempStorage,
  AutomationStorage,
  AutomationAI,
  AIGenerateOptions,
  CallServiceOptions,
  PublishedEntityOptions,
  PublishedSensor,
  PublishedBinarySensor,
  AutomationPublish,
  LogLevel,
} from "./types";

// ─── Import manager accessor ────────────────────────────────

import { Automation } from "./automation";
import type { CallServiceOptions } from "./types";

function getManager(): any {
  const mgr = (global as any).__tae_automation_manager;
  if (!mgr) {
    throw new Error("TAE runtime not initialized. Automations must be loaded by the TAE worker.");
  }
  return mgr;
}

// ─── Lifecycle functions ─────────────────────────────────────

/**
 * Register an automation instance with the engine.
 * Must be called before startAutomation().
 */
export function registerAutomation(automation: Automation): void {
  getManager().register(automation);
}

/**
 * Start a registered automation. Calls onStart().
 */
export function startAutomation(automation: Automation): void {
  getManager().start(automation);
}

/**
 * Stop a running automation. Calls onStop() and cleans up subscriptions.
 */
export function stopAutomation(automation: Automation): void {
  getManager().stop(automation);
}

// ─── Explicit API (automation as first argument) ──────────

/**
 * Call a Home Assistant service. Requires running automation.
 */
export async function callService(
  automation: Automation,
  domain: string,
  service: string,
  data?: Record<string, any>,
  options?: CallServiceOptions
): Promise<any> {
  return getManager().callService(automation, domain, service, data, options);
}

/**
 * Subscribe to a specific HA event type.
 */
export function subscribeToEvent(
  automation: Automation,
  eventType: string,
  callback: (event: any) => void | Promise<void>
): () => void {
  return getManager().subscribeToEvent(automation, eventType, callback);
}

/**
 * Subscribe to state changes for a specific entity.
 */
export function subscribeToStateChangeEvent(
  automation: Automation,
  entityId: string,
  callback: (data: any) => void | Promise<void>,
  emitAll?: boolean
): () => void {
  return getManager().subscribeToStateChangeEvent(automation, entityId, callback, emitAll);
}

/**
 * Subscribe to all state changes.
 */
export function onStateChange(
  automation: Automation,
  callback: (data: any) => void | Promise<void>,
  emitAll?: boolean
): () => void {
  return getManager().onStateChange(automation, callback, emitAll);
}

/**
 * Get a list of all currently registered automation instances
 * (id, className, state). Useful for inspecting or driving start/stop
 * decisions from another automation or a startup script.
 *
 * @example
 * import { getAutomations, stopAutomation } from 'tae';
 * for (const a of getAutomations()) {
 *   console.log(a.id, a.state);
 * }
 */
export function getAutomations(): Array<{ id: string; className: string; state: string }> {
  return getManager().getAutomations();
}

// ─── Standalone state access ─────────────────────────────────

import type { HAEntityState } from "./types";

/**
 * Read an entity's current state synchronously from TAE's local copy.
 * The copy is updated before state-change callbacks run, so it is current
 * inside a callback. No network call.
 *
 * @example
 * const guestMode = getEntityState('input_boolean.guest_mode')?.state === 'on';
 */
export function getEntityState(entityId: string): HAEntityState | undefined {
  return getManager().getEntityStateSync(entityId);
}

/**
 * A secret (API key, password) set in TAE's Secrets tab. Throws when there is no secret with that name.
 * Read it when you use it, not into a top-level constant, so a changed value is picked up without a reload.
 *
 * @example
 * const response = await fetch(url, { headers: { Authorization: `Bearer ${getSecret('meteoblue_api_key')}` } });
 */
export function getSecret(name: string): string {
  return getManager().getSecret(name);
}

/** Whether a secret with this name is set in TAE's Secrets tab. */
export function hasSecret(name: string): boolean {
  return getManager().hasSecret(name);
}

/**
 * Fetch entity state live from HA API (fresh but slower).
 */
export async function fetchEntityState(entityId: string): Promise<HAEntityState | undefined> {
  return getManager().fetchEntityState(entityId);
}

// ─── Standalone logging (for use outside automation context) ──

export function log(message: any, extra?: any): void {
  getManager().logMessage("info", "user", message, extra);
}

export function warn(message: any, extra?: any): void {
  getManager().logMessage("warn", "user", message, extra);
}

export function error(message: any, extra?: any): void {
  getManager().logMessage("error", "user", message, extra);
}

export function debug(message: any, extra?: any): void {
  getManager().logMessage("debug", "user", message, extra);
}
