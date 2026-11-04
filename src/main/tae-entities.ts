/**
 * TAE's own entities in Home Assistant: an engine status sensor and one switch per automation
 * (on = running; switching it starts or stops the automation).
 */

import type { AutomationInfo } from "../shared/messages";
import type { Logger } from "./logging";
import type { MqttEntities } from "./mqtt-entities";
import type { WorkerManager } from "./worker-manager";

const STATUS_ID = "tae_status";
const SWITCH_PREFIX = "tae_";
const PRUNE_DELAY_MS = 15000; //< after a load: time for HA's retained switches to arrive before old ones are removed

/** "SpotifyFollowsPc" → "spotify_follows_pc" */
export function snakeCase(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** "SpotifyFollowsPc" → "Spotify follows pc" */
function readableName(id: string): string {
  const words = snakeCase(id).split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function startTaeEntities(mqtt: MqttEntities, workers: WorkerManager, logger: Logger, version: string): void {
  const switchIds = new Map<string, string>(); //< automation id → switch object id

  mqtt.define({ component: "sensor", objectId: STATUS_ID, name: "Status", icon: "mdi:language-typescript" });

  const publish = (automations: AutomationInfo[]) => {
    const running = automations.filter((automation) => automation.state === "running").length;
    const errored = automations.filter((automation) => automation.state === "error" || (automation.errorCount ?? 0) > 0).length;
    mqtt.setState("sensor", STATUS_ID, workers.isRunning() ? "running" : "stopped", {
      version,
      automations: automations.length,
      running,
      stopped: automations.length - running,
      with_errors: errored,
    });
    for (const automation of automations) {
      const objectId = SWITCH_PREFIX + snakeCase(automation.id);
      if (!switchIds.has(automation.id)) {
        switchIds.set(automation.id, objectId);
        mqtt.define({ component: "switch", objectId, name: readableName(automation.id), icon: "mdi:robot-outline" });
        mqtt.onCommand("switch", objectId, (payload) => {
          if (payload === "ON") workers.startAutomation(automation.id);
          else if (payload === "OFF") workers.stopAutomation(automation.id);
        });
      }
      mqtt.setState("switch", objectId, automation.state === "running" ? "ON" : "OFF", {
        automation: automation.id,
        class: automation.className,
        state: automation.state,
        error: automation.error ?? null,
        last_error: automation.lastError ?? null,
        last_error_at: automation.lastErrorAt ?? null,
        error_count: automation.errorCount ?? 0,
      });
    }
  };

  workers.onAutomationsChanged(publish);
  publish(workers.getAutomations());

  // after a full load, drop the switches of automations that no longer exist
  workers.onInitComplete(() => {
    setTimeout(() => {
      const current = new Set(workers.getAutomations().map((automation) => automation.id));
      for (const [automationId, objectId] of switchIds) {
        if (current.has(automationId)) continue;
        mqtt.remove("switch", objectId);
        switchIds.delete(automationId);
      }
      const removed = mqtt.pruneSwitches();
      if (removed.length) logger.log("info", "mqtt", `Removed switches of deleted automations: ${removed.join(", ")}`);
    }, PRUNE_DELAY_MS);
  });
}
