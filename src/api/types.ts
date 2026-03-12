/**
 * TAE API — Type definitions used across the API module.
 */

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

export interface StateChangeData {
  entity_id: string;
  old_state: HAEntityState | null;
  new_state: HAEntityState | null;
}

export type AutomationState = "running" | "stopped" | "error" | "deleted";

/** Log level for automation logging. */
export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export type EventCallback = (event: HAEvent) => void | Promise<void>;
export type StateChangeCallback = (data: StateChangeData) => void | Promise<void>;
export type UnsubscribeFunction = () => void;

export interface PersistentStorage {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface TempStorage {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AutomationStorage {
  persistent: PersistentStorage;
  temp: TempStorage;
}
