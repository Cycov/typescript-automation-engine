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
  LogLevel,
} from "./types";

// ─── Import manager accessor ────────────────────────────────

import { Automation } from "./automation";

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
  data?: Record<string, any>
): Promise<any> {
  return getManager().callService(automation, domain, service, data);
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
  callback: (data: any) => void | Promise<void>
): () => void {
  return getManager().subscribeToStateChangeEvent(automation, entityId, callback);
}

/**
 * Subscribe to all state changes.
 */
export function onStateChange(
  automation: Automation,
  callback: (data: any) => void | Promise<void>
): () => void {
  return getManager().onStateChange(automation, callback);
}

// ─── Standalone state access ─────────────────────────────────

import type { HAEntityState } from "./types";

/**
 * Read entity state from in-memory cache (fast, no network, may be stale).
 */
export function getEntityState(entityId: string): HAEntityState | undefined {
  return getManager().getEntityState(entityId);
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
