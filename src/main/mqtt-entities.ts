/**
 * Home Assistant entities owned by TAE, published over MQTT discovery: sensors that automations
 * publish (this.sensor / this.binarySensor) and TAE's own status and per-automation switches.
 * Discovery and states are retained, so HA keeps them across its own restarts.
 */

import mqtt, { type MqttClient } from "mqtt";
import { Logger } from "./logging";

const DISCOVERY_PREFIX = "homeassistant";
const BASE_TOPIC = "tae";
const AVAILABILITY_TOPIC = `${BASE_TOPIC}/availability`;
const HA_STATUS_TOPIC = `${DISCOVERY_PREFIX}/status`; //< HA's birth message: republish when it comes back
const SUPERVISOR_MQTT_URL = "http://supervisor/services/mqtt";
const RECONNECT_MS = 10000;
const CONNECT_TIMEOUT_MS = 15000;
const OBJECT_ID_PATTERN = /^[a-z0-9_]+$/;
const MAX_ATTRIBUTES_BYTES = 16000; //< HA's recorder skips larger attributes

export type EntityComponent = "sensor" | "binary_sensor" | "switch";

export interface EntityDefinition {
  component: EntityComponent;
  objectId: string; //< entity id after the dot, e.g. "meteoblue_forecast"
  name?: string;
  icon?: string;
  unit?: string;
  deviceClass?: string;
  stateClass?: string;
  owner?: string; //< automation id that publishes it (none = TAE itself)
}

interface Published {
  definition: EntityDefinition;
  state?: string;
  attributes?: Record<string, unknown>;
}

export interface MqttSettings {
  url: string;
  username?: string;
  password?: string;
}

/** MQTT broker details: the Supervisor's MQTT service (Mosquitto app), or TAE_MQTT_* for local development. */
export async function findMqttSettings(supervisorToken: string): Promise<MqttSettings | null> {
  if (process.env.TAE_MQTT_URL) {
    return { url: process.env.TAE_MQTT_URL, username: process.env.TAE_MQTT_USERNAME, password: process.env.TAE_MQTT_PASSWORD };
  }
  if (!supervisorToken) return null;
  try {
    const response = await fetch(SUPERVISOR_MQTT_URL, { headers: { Authorization: `Bearer ${supervisorToken}` } });
    if (!response.ok) return null;
    const { data } = (await response.json()) as { data?: { host: string; port: number; ssl?: boolean; username?: string; password?: string } };
    if (!data?.host) return null;
    return { url: `${data.ssl ? "mqtts" : "mqtt"}://${data.host}:${data.port}`, username: data.username, password: data.password };
  } catch {
    return null;
  }
}

export class MqttEntities {
  private client: MqttClient | null = null;
  private entities = new Map<string, Published>(); //< "component.objectId" → definition + last state
  private commandHandlers = new Map<string, (payload: string) => void>();
  private retainedSwitches = new Set<string>(); //< switch object ids HA still has from earlier runs
  private logger: Logger;
  private version: string;

  constructor(logger: Logger, version: string) {
    this.logger = logger;
    this.version = version;
  }

  isConnected(): boolean {
    return !!this.client?.connected;
  }

  connect(settings: MqttSettings): void {
    this.client = mqtt.connect(settings.url, {
      username: settings.username,
      password: settings.password,
      clientId: `tae_${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: RECONNECT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      will: { topic: AVAILABILITY_TOPIC, payload: "offline", retain: true, qos: 1 },
    });
    this.client.on("connect", () => {
      this.logger.log("info", "mqtt", `Connected to MQTT at ${settings.url}; publishing entities`);
      this.client!.publish(AVAILABILITY_TOPIC, "online", { retain: true, qos: 1 });
      this.client!.subscribe([HA_STATUS_TOPIC, `${BASE_TOPIC}/+/+/set`, `${DISCOVERY_PREFIX}/switch/${BASE_TOPIC}/+/config`]);
      this.republishAll();
    });
    this.client.on("message", (topic, payload) => this.onMessage(topic, payload.toString()));
    this.client.on("error", (err) => this.logger.log("warn", "mqtt", `MQTT: ${err.message}`));
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    this.client.publish(AVAILABILITY_TOPIC, "offline", { retain: true, qos: 1 });
    await this.client.endAsync();
    this.client = null;
  }

  /** Creates or updates an entity's definition (published once, again when it changes). */
  define(definition: EntityDefinition): void {
    if (!OBJECT_ID_PATTERN.test(definition.objectId)) {
      throw new Error(`Invalid entity id "${definition.objectId}": use lowercase letters, digits and _`);
    }
    const key = this.key(definition.component, definition.objectId);
    const existing = this.entities.get(key);
    if (existing?.definition.owner && definition.owner && existing.definition.owner !== definition.owner) {
      throw new Error(`${key} is already published by ${existing.definition.owner}`);
    }
    if (existing && JSON.stringify(existing.definition) === JSON.stringify(definition)) return;
    this.entities.set(key, { ...existing, definition });
    this.publishDiscovery(definition);
  }

  setState(component: EntityComponent, objectId: string, state: string, attributes?: Record<string, unknown>): void {
    const key = this.key(component, objectId);
    const entity = this.entities.get(key);
    if (!entity) throw new Error(`${key} is not defined`);
    if (attributes && JSON.stringify(attributes).length > MAX_ATTRIBUTES_BYTES) {
      this.logger.log("warn", entity.definition.owner || "mqtt", `${key}: attributes are over ${MAX_ATTRIBUTES_BYTES} bytes; HA's history won't keep them`);
    }
    const unchanged = entity.state === state && (!attributes || JSON.stringify(attributes) === JSON.stringify(entity.attributes));
    entity.state = state;
    if (attributes) entity.attributes = attributes;
    if (!unchanged) this.publishState(entity); //< retained: HA already has it
  }

  /** Removes an entity from HA (empty retained discovery message). */
  remove(component: EntityComponent, objectId: string): void {
    const key = this.key(component, objectId);
    if (!this.entities.delete(key)) return;
    this.commandHandlers.delete(key);
    this.client?.publish(this.discoveryTopic(component, objectId), "", { retain: true, qos: 1 });
  }

  /** Removes switches HA still has from earlier runs that are no longer defined (e.g. a deleted automation). */
  pruneSwitches(): string[] {
    const removed: string[] = [];
    for (const objectId of this.retainedSwitches) {
      if (this.entities.has(this.key("switch", objectId))) continue;
      this.client?.publish(this.discoveryTopic("switch", objectId), "", { retain: true, qos: 1 });
      this.retainedSwitches.delete(objectId);
      removed.push(objectId);
    }
    return removed;
  }

  /** Entities a given automation published (for cleanup when it disappears). */
  ownedBy(automationId: string): { component: EntityComponent; objectId: string }[] {
    return [...this.entities.values()]
      .filter((entity) => entity.definition.owner === automationId)
      .map(({ definition }) => ({ component: definition.component, objectId: definition.objectId }));
  }

  onCommand(component: EntityComponent, objectId: string, handler: (payload: string) => void): void {
    this.commandHandlers.set(this.key(component, objectId), handler);
  }

  private key(component: EntityComponent, objectId: string): string {
    return `${component}.${objectId}`;
  }

  private discoveryTopic(component: EntityComponent, objectId: string): string {
    return `${DISCOVERY_PREFIX}/${component}/${BASE_TOPIC}/${objectId}/config`;
  }

  private topic(component: EntityComponent, objectId: string, suffix: string): string {
    return `${BASE_TOPIC}/${component}/${objectId}/${suffix}`;
  }

  private publishDiscovery(definition: EntityDefinition): void {
    if (!this.client?.connected) return; //< sent on connect
    const { component, objectId } = definition;
    const config: Record<string, unknown> = {
      name: definition.name ?? null, //< null: the entity is named after the device
      unique_id: `${BASE_TOPIC}_${component}_${objectId}`,
      default_entity_id: `${component}.${objectId}`,
      state_topic: this.topic(component, objectId, "state"),
      json_attributes_topic: this.topic(component, objectId, "attributes"),
      availability_topic: AVAILABILITY_TOPIC,
      device: {
        identifiers: ["typescript_automation_engine"],
        name: "TAE",
        manufacturer: "TypeScript Automation Engine",
        model: "Automations",
        sw_version: this.version,
      },
      origin: { name: "TypeScript Automation Engine", sw_version: this.version },
    };
    if (definition.icon) config.icon = definition.icon;
    if (definition.unit) config.unit_of_measurement = definition.unit;
    if (definition.deviceClass) config.device_class = definition.deviceClass;
    if (definition.stateClass) config.state_class = definition.stateClass;
    if (component === "switch") config.command_topic = this.topic(component, objectId, "set");
    if (component === "binary_sensor" || component === "switch") {
      config.payload_on = "ON";
      config.payload_off = "OFF";
    }
    this.client.publish(this.discoveryTopic(component, objectId), JSON.stringify(config), { retain: true, qos: 1 });
  }

  private publishState(entity: Published): void {
    if (!this.client?.connected || entity.state === undefined) return;
    const { component, objectId } = entity.definition;
    this.client.publish(this.topic(component, objectId, "attributes"), JSON.stringify(entity.attributes ?? {}), { retain: true, qos: 1 });
    this.client.publish(this.topic(component, objectId, "state"), entity.state, { retain: true, qos: 1 });
  }

  private republishAll(): void {
    for (const entity of this.entities.values()) {
      this.publishDiscovery(entity.definition);
      this.publishState(entity);
    }
  }

  private onMessage(topic: string, payload: string): void {
    if (topic === HA_STATUS_TOPIC) {
      if (payload === "online") this.republishAll();
      return;
    }
    const retained = topic.match(new RegExp(`^${DISCOVERY_PREFIX}/switch/${BASE_TOPIC}/([a-z0-9_]+)/config$`));
    if (retained) {
      if (payload) this.retainedSwitches.add(retained[1]);
      else this.retainedSwitches.delete(retained[1]);
      return;
    }
    const match = topic.match(new RegExp(`^${BASE_TOPIC}/([a-z_]+)/([a-z0-9_]+)/set$`));
    if (!match) return;
    const handler = this.commandHandlers.get(this.key(match[1] as EntityComponent, match[2]));
    try {
      handler?.(payload);
    } catch (err: any) {
      this.logger.log("error", "mqtt", `Command on ${topic} failed: ${err?.message ?? err}`);
    }
  }
}
