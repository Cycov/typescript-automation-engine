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

export interface CallServiceOptions {
  /** Ask Home Assistant for the service's response data (e.g. `weather.get_forecasts`); the call then resolves with it. */
  returnResponse?: boolean;
}

export interface AIGenerateOptions {
  /** Instructions for the model: role, tone, format, length. */
  system?: string;
  /** `"fast"` (default) uses the Automations model from TAE's AI settings, `"smart"` the chat model. */
  model?: "fast" | "smart";
  /** Upper bound on the answer length in tokens (default 500, at most 4000). */
  maxTokens?: number;
  /** Give up after this long (default 30 s, at most 120 s). */
  timeoutMs?: number;
}

/** Text generation with the AI provider set in TAE's AI settings. */
export interface AutomationAI {
  /**
   * Generate text from a prompt. Resolves with the model's answer, trimmed.
   * Rejects when AI is not configured, the request fails or times out, or the
   * automation exceeds its hourly request limit — keep a fallback text.
   */
  generate(prompt: string, options?: AIGenerateOptions): Promise<string>;
}
