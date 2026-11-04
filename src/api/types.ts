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

/** How a published entity looks in Home Assistant. All optional. */
export interface PublishedEntityOptions {
  /** Shown name; defaults to the device name "TAE". HA shows it as "TAE <name>". */
  name?: string;
  /** MDI icon, e.g. "mdi:weather-partly-cloudy". */
  icon?: string;
  /** Unit of measurement, e.g. "°C" or "W" (sensors). */
  unit?: string;
  /** HA device class, e.g. "temperature", "power", "door". */
  deviceClass?: string;
  /** HA state class for statistics, e.g. "measurement" (sensors). */
  stateClass?: string;
}

/** A sensor this automation publishes to Home Assistant (over MQTT; needs the Mosquitto broker app). */
export interface PublishedSensor {
  /** Sets the state (null = unknown) and, optionally, attributes. The entity is created on the first call. */
  set(state: string | number | null, attributes?: Record<string, unknown>): Promise<void>;
  /** Removes the entity from Home Assistant. */
  remove(): Promise<void>;
}

/** A binary sensor (on/off) this automation publishes to Home Assistant. */
export interface PublishedBinarySensor {
  set(on: boolean, attributes?: Record<string, unknown>): Promise<void>;
  remove(): Promise<void>;
}

/** this.publish: entities this automation publishes to Home Assistant. */
export interface AutomationPublish {
  /** A sensor published as `sensor.<objectId>`, created on the first `set()`. */
  sensor(objectId: string, options?: PublishedEntityOptions): PublishedSensor;
  /** A binary sensor (on/off) published as `binary_sensor.<objectId>`. */
  binarySensor(objectId: string, options?: PublishedEntityOptions): PublishedBinarySensor;
}
