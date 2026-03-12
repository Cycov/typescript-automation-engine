/**
 * Automation Base Class
 *
 * Every automation must extend this class. It provides:
 * - Lifecycle hooks: onStart(), onStop(), onReload(), onUnload()
 * - Instance-bound HA API helpers (this.callService, this.subscribeToEvent, etc.)
 * - Logging helpers (this.log, this.warn, this.error, this.debug)
 * - Namespaced storage (this.storage.persistent, this.storage.temp)
 * - Automatic ID generation
 */

import {
  HAEntityState,
  HAEvent,
  StateChangeData,
  AutomationState,
  EventCallback,
  StateChangeCallback,
  UnsubscribeFunction,
  AutomationStorage,
  PersistentStorage,
  TempStorage,
  LogLevel,
} from "./types";

// Counter for auto-generated IDs, keyed by class name
const classCounters = new Map<string, number>();

/**
 * Get the automation manager from the global bridge.
 * This is set by the worker before loading automations.
 */
function getManager(): any {
  const mgr = (global as any).__tae_automation_manager;
  if (!mgr) {
    throw new Error("TAE runtime not initialized. Automations must be loaded by the TAE worker.");
  }
  return mgr;
}

export abstract class Automation {
  /** Unique identifier for this automation instance. Auto-generated or manually set in constructor. */
  public readonly id: string;
  /** The class name of this automation (e.g., `"MotionLightAutomation"`). */
  public readonly className: string;
  /** Current state: `"running"`, `"stopped"`, or `"error"`. */
  public state: AutomationState = "stopped";
  /** If state is `"error"`, this contains the error message. */
  public errorMessage?: string;
  /**
   * Namespaced storage for this automation.
   * - `this.storage.persistent` — SQLite-backed, survives restarts.
   * - `this.storage.temp` — In-memory, cleared on restart.
   *
   * Each automation gets its own namespace so keys don't collide.
   *
   * @example
   * await this.storage.persistent.set('lastRun', Date.now());
   * const lastRun = await this.storage.persistent.get('lastRun');
   * await this.storage.temp.set('counter', 0);
   */
  public readonly storage: AutomationStorage;

  /**
   * Create a new automation instance.
   *
   * @param id - Optional custom ID. If omitted, an ID is auto-generated from the class name
   *   with an incrementing counter (e.g., `"MotionLight1"`, `"MotionLight2"`).
   *
   * @example
   * // Auto-generated ID
   * const auto = new MotionLightAutomation();  // → id: "MotionLightAutomation1"
   *
   * // Custom ID
   * const auto = new MotionLightAutomation('kitchen-motion');  // → id: "kitchen-motion"
   */
  constructor(id?: string) {
    this.className = this.constructor.name;

    if (id) {
      this.id = id;
    } else {
      const count = (classCounters.get(this.className) || 0) + 1;
      classCounters.set(this.className, count);
      this.id = `${this.className}${count}`;
    }

    // Set up namespaced storage
    const automationId = this.id;
    const persistent: PersistentStorage = {
      get: (key: string) => getManager().storageGet(automationId, key, true),
      set: (key: string, value: any) => getManager().storageSet(automationId, key, value, true),
      delete: (key: string) => getManager().storageDelete(automationId, key, true),
    };
    const temp: TempStorage = {
      get: (key: string) => getManager().storageGet(automationId, key, false),
      set: (key: string, value: any) => getManager().storageSet(automationId, key, value, false),
      delete: (key: string) => getManager().storageDelete(automationId, key, false),
    };
    this.storage = { persistent, temp };
  }

  // ─── Lifecycle hooks (override in subclass) ────────────────

  /**
   * Called when the automation starts. Set up your event subscriptions,
   * state watchers, and initial logic here.
   *
   * Subscriptions created during `onStart()` are automatically cleaned up
   * when the automation stops — you don't need to manually unsubscribe.
   *
   * @example
   * async onStart() {
   *   this.subscribeToStateChangeEvent('binary_sensor.motion', (data) => {
   *     if (data.new_state?.state === 'on') {
   *       this.callService('light', 'turn_on', { entity_id: 'light.hallway' });
   *     }
   *   });
   *   this.log('Motion light automation started');
   * }
   */
  async onStart(): Promise<void> {}

  /**
   * Called when the automation is stopped (via UI or API).
   * Use for cleanup of non-subscription resources (e.g., clearing timers).
   * Event subscriptions are auto-cleaned — no need to unsubscribe here.
   */
  async onStop(): Promise<void> {}

  /**
   * Called when the engine performs a reload.
   * The automation stays registered but the engine re-evaluates its state.
   */
  async onReload(): Promise<void> {}

  /**
   * Called when the automation is permanently removed from the runtime
   * (e.g., before the engine shuts down). Use for final cleanup.
   */
  async onUnload(): Promise<void> {}

  // ─── HA Client helpers (instance-bound) ────────────────────

  /**
   * Call a Home Assistant service.
   *
   * @param domain - The service domain (the part before the dot in HA service calls).
   *   Common domains: `"light"`, `"switch"`, `"climate"`, `"media_player"`, `"notify"`,
   *   `"automation"`, `"scene"`, `"script"`, `"input_boolean"`, `"cover"`, `"fan"`.
   * @param service - The service action to call (the part after the dot).
   *   Examples: `"turn_on"`, `"turn_off"`, `"toggle"`, `"set_temperature"`, `"send_message"`.
   * @param data - Optional service data payload. Typically includes `entity_id` and
   *   service-specific parameters.
   * @returns A promise that resolves with the HA service response.
   *
   * @example
   * // Turn on a light with brightness
   * await this.callService('light', 'turn_on', {
   *   entity_id: 'light.living_room',
   *   brightness: 200,
   *   color_temp: 350,
   * });
   *
   * @example
   * // Send a notification
   * await this.callService('notify', 'mobile_app_your_phone', {
   *   message: 'Motion detected!',
   *   title: 'Security Alert',
   * });
   *
   * @example
   * // Toggle a switch
   * await this.callService('switch', 'toggle', {
   *   entity_id: 'switch.garage_door',
   * });
   */
  async callService(
    domain: string,
    service: string,
    data?: Record<string, any>
  ): Promise<any> {
    return getManager().callService(this, domain, service, data);
  }

  /**
   * Subscribe to a specific Home Assistant event type.
   * Subscriptions are automatically cleaned up when the automation stops.
   *
   * @param eventType - The HA event type to listen for.
   *   Common events: `"state_changed"`, `"call_service"`, `"automation_triggered"`,
   *   `"zha_event"`, `"deconz_event"`, `"timer.finished"`, `"homeassistant_start"`.
   * @param callback - Function called when the event fires. Receives the full
   *   HA event object with `event_type`, `data`, `origin`, `time_fired`, and `context`.
   * @returns An unsubscribe function. Call it to stop receiving events early.
   *
   * @example
   * this.subscribeToEvent('zha_event', (event) => {
   *   if (event.data.command === 'toggle') {
   *     this.log('ZHA toggle received', event.data);
   *   }
   * });
   */
  subscribeToEvent(
    eventType: string,
    callback: EventCallback
  ): UnsubscribeFunction {
    return getManager().subscribeToEvent(this, eventType, callback);
  }

  /**
   * Subscribe to state changes for a specific entity.
   * Subscriptions are automatically cleaned up when the automation stops.
   *
   * @param entityId - The entity to watch (e.g., `"binary_sensor.motion_kitchen"`,
   *   `"sensor.temperature_living_room"`, `"light.bedroom"`).
   * @param callback - Function called when the entity's state changes.
   *   Receives `{ entity_id, old_state, new_state }` where each state contains
   *   `state` (string value), `attributes`, `last_changed`, and `last_updated`.
   * @returns An unsubscribe function.
   *
   * @example
   * this.subscribeToStateChangeEvent('binary_sensor.front_door', (data) => {
   *   if (data.new_state?.state === 'on') {
   *     this.log('Front door opened!');
   *     await this.callService('notify', 'mobile_app_phone', {
   *       message: 'Front door was opened',
   *     });
   *   }
   * });
   */
  subscribeToStateChangeEvent(
    entityId: string,
    callback: StateChangeCallback
  ): UnsubscribeFunction {
    return getManager().subscribeToStateChangeEvent(this, entityId, callback);
  }

  /**
   * Subscribe to all state changes (no entity filter).
   * Use this when you want to react to any entity state change — useful for
   * cross-entity logic or monitoring dashboards.
   *
   * @param callback - Function called for every state change in HA.
   *   Receives `{ entity_id, old_state, new_state }`.
   * @returns An unsubscribe function.
   *
   * @example
   * this.onStateChange((data) => {
   *   if (data.entity_id.startsWith('light.') && data.new_state?.state === 'on') {
   *     this.debug(`Light turned on: ${data.entity_id}`);
   *   }
   * });
   */
  onStateChange(callback: StateChangeCallback): UnsubscribeFunction {
    return getManager().onStateChange(this, callback);
  }

  /**
   * Get an entity's current state from the in-memory cache.
   * This is fast (no network call) but may be slightly stale.
   *
   * @param entityId - The entity ID to look up (e.g., `"sensor.temperature"`).
   * @returns The cached entity state, or undefined if not found.
   *
   * @example
   * const state = await this.getEntityState('sensor.outdoor_temperature');
   * if (state) {
   *   this.log(`Current temp: ${state.state}°C`);
   *   this.log(`Attributes: `, state.attributes);
   * }
   */
  async getEntityState(entityId: string): Promise<HAEntityState | undefined> {
    return getManager().getEntityState(entityId);
  }

  /**
   * Fetch an entity's current state directly from Home Assistant.
   * Makes a live API call — use this when you need the freshest data.
   *
   * @param entityId - The entity ID to fetch (e.g., `"sensor.temperature"`).
   * @returns The live entity state, or undefined if not found.
   */
  async fetchEntityState(entityId: string): Promise<HAEntityState | undefined> {
    return getManager().fetchEntityState(entityId);
  }

  // ─── Logging helpers ──────────────────────────────────────

  /**
   * Log a message. Defaults to info level.
   * @param message - The message to log (string or object).
   * @param levelOrExtra - Optional LogLevel to override the default, or extra data to attach.
   *
   * @example
   * this.log('Hello world');                        // info level
   * this.log('Debug info', LogLevel.Debug);         // debug level
   * this.log({ entities: ['light.bedroom'] });      // info level, object message
   * this.log('Details', { count: 5 });              // info level with extra data
   */
  log(message: any, levelOrExtra?: LogLevel | any): void {
    if (typeof levelOrExtra === "string" && Object.values(LogLevel).includes(levelOrExtra as LogLevel)) {
      getManager().logMessage(levelOrExtra, this.id, message);
    } else {
      getManager().logMessage("info", this.id, message, levelOrExtra);
    }
  }

  /** Log a warning message. */
  warn(message: any, extra?: any): void {
    getManager().logMessage("warn", this.id, message, extra);
  }

  /** Log an error message. */
  error(message: any, extra?: any): void {
    getManager().logMessage("error", this.id, message, extra);
  }

  /** Log a debug message. */
  debug(message: any, extra?: any): void {
    getManager().logMessage("debug", this.id, message, extra);
  }
}
