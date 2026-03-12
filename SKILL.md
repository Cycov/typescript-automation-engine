# TAE Automation Skill

You are an expert at writing TypeScript automations for the **TAE (TypeScript Automation Engine)** Home Assistant addon. Use this skill to generate complete, ready-to-run automation files.

## Project Structure

Automations live in `/root/addons/typescript-automation-engine/automations/`. The entry point is `automations/index.ts`. You can create additional files and import them from `index.ts`.

## Core Pattern

Every automation **must** follow this pattern:

```typescript
import { Automation, registerAutomation, startAutomation, LogLevel } from 'tae';

class MyAutomation extends Automation {
  async onStart() {
    // Set up subscriptions and logic here
  }

  async onStop() {
    // Optional cleanup (subscriptions are auto-cleaned)
  }
}

// onInit is the entry point — called when the engine loads this file
export async function onInit() {
  const auto = new MyAutomation();       // or new MyAutomation('custom-id')
  registerAutomation(auto);
  startAutomation(auto);
}
```

**Rules:**
- Every file that defines automations MUST export an `onInit()` function
- `onInit()` must call `registerAutomation()` then `startAutomation()` for each automation
- Multiple automations can be in one file — create, register, and start each one in `onInit()`
- The constructor optionally takes a custom string ID; if omitted, auto-generates from class name

## Full API Reference

### Types

```typescript
interface HAEntityState {
  entity_id: string;
  state: string;                // e.g. "on", "off", "22.5", "home", "unavailable"
  attributes: Record<string, any>;
  last_changed: string;         // ISO timestamp
  last_updated: string;         // ISO timestamp
  context: { id: string; parent_id: string | null; user_id: string | null };
}

interface StateChangeData {
  entity_id: string;
  old_state: HAEntityState | null;  // null if entity was just created
  new_state: HAEntityState | null;  // null if entity was removed
}

interface HAEvent {
  event_type: string;
  data: Record<string, any>;
  origin: string;
  time_fired: string;
  context: { id: string; parent_id: string | null; user_id: string | null };
}

enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}
```

### Instance Methods (available via `this.` inside an Automation subclass)

#### `this.callService(domain, service, data?)`
Call any Home Assistant service.

| Param    | Type                     | Description |
|----------|--------------------------|-------------|
| `domain` | `string`                 | Service domain: `"light"`, `"switch"`, `"climate"`, `"notify"`, `"media_player"`, `"automation"`, `"scene"`, `"script"`, `"input_boolean"`, `"input_number"`, `"input_select"`, `"input_text"`, `"cover"`, `"fan"`, `"vacuum"`, `"lock"`, `"alarm_control_panel"`, `"camera"`, `"tts"`, `"number"`, `"select"`, `"button"` |
| `service`| `string`                 | Action: `"turn_on"`, `"turn_off"`, `"toggle"`, `"set_temperature"`, `"send_message"`, `"set_hvac_mode"`, `"set_value"`, `"select_option"`, `"press"`, `"set_cover_position"`, `"set_speed"`, `"start"`, `"stop"`, `"set_volume_level"`, `"play_media"` |
| `data`   | `Record<string, any>?`   | Usually includes `entity_id`. Other fields are service-specific. |
| Returns  | `Promise<any>`           | HA response (usually null for fire-and-forget). |

#### `this.subscribeToStateChangeEvent(entityId, callback)`
Watch a specific entity for state changes. **This is the most commonly used method.**

| Param      | Type                                  | Description |
|------------|---------------------------------------|-------------|
| `entityId` | `string`                              | Full entity ID: `"binary_sensor.motion"`, `"sensor.temperature"`, `"light.bedroom"`, etc. |
| `callback` | `(data: StateChangeData) => void`     | Called when the entity changes. |
| Returns    | `() => void`                          | Unsubscribe function (optional — auto-cleaned on stop). |

#### `this.subscribeToEvent(eventType, callback)`
Listen for raw HA events. Use `subscribeToStateChangeEvent` for state changes instead.

| Param       | Type                          | Description |
|-------------|-------------------------------|-------------|
| `eventType` | `string`                      | Event type: `"state_changed"`, `"call_service"`, `"zha_event"`, `"deconz_event"`, `"timer.finished"`, `"automation_triggered"`, `"homeassistant_start"`, etc. |
| `callback`  | `(event: HAEvent) => void`    | Called per event. |
| Returns     | `() => void`                  | Unsubscribe function. |

#### `this.onStateChange(callback)`
Listen to ALL entity state changes. Fires very frequently — use sparingly.

| Param      | Type                                  | Description |
|------------|---------------------------------------|-------------|
| `callback` | `(data: StateChangeData) => void`     | Called for every state change in HA. |
| Returns    | `() => void`                          | Unsubscribe function. |

#### `this.getEntityState(entityId)` / `this.fetchEntityState(entityId)`

| Method             | Description                                               | Returns |
|--------------------|-----------------------------------------------------------|---------|
| `getEntityState`   | Read from in-memory cache (fast, no network, may be stale) | `Promise<HAEntityState \| undefined>` |
| `fetchEntityState` | Live API call to HA (fresh but slower)                     | `Promise<HAEntityState \| undefined>` |

#### Logging

```typescript
this.log('message');                        // INFO
this.log('message', LogLevel.Debug);        // DEBUG
this.warn('message');                       // WARN
this.error('message');                      // ERROR
this.debug('message');                      // DEBUG
this.log('details', { key: 'value' });      // INFO with extra data
this.log({ complex: 'object' });            // INFO, object pretty-printed
```

#### Storage

```typescript
// Persistent (SQLite, survives restarts) — values are JSON-serialized
await this.storage.persistent.set('key', value);
const val = await this.storage.persistent.get('key');   // returns value or undefined
await this.storage.persistent.delete('key');

// Temporary (in-memory, cleared on restart)
await this.storage.temp.set('key', value);
const val = await this.storage.temp.get('key');
await this.storage.temp.delete('key');
```

### Standalone Functions

For use in `onInit()` or utility files outside the class.

```typescript
import {
  registerAutomation, startAutomation, stopAutomation,
  callService, subscribeToEvent, subscribeToStateChangeEvent, onStateChange,
  log, warn, error, debug, LogLevel,
} from 'tae';
```

HA API functions take the automation instance as first arg: `callService(auto, 'light', 'turn_on', {...})`.
Standalone state access (no automation arg needed): `getEntityState('light.bedroom')`, `await fetchEntityState('sensor.temp')`.
Standalone logging logs with source `"user"`: `log('message')`, `debug('detail')`.

### Lifecycle Hooks

| Hook         | When Called                              | Use For                              |
|--------------|------------------------------------------|--------------------------------------|
| `onStart()`  | Automation starts (via `startAutomation`) | Setting up subscriptions and logic   |
| `onStop()`   | Automation stops (via UI or API)         | Cleaning up non-subscription resources (timers, intervals) |
| `onReload()` | Engine performs a reload                 | Re-evaluating state                  |
| `onUnload()` | Automation permanently removed           | Final cleanup before shutdown        |

## Common Patterns and Templates

### 1. Motion-Activated Lights

Turn lights on when motion is detected, off when cleared.

```typescript
import { Automation, registerAutomation, startAutomation } from 'tae';

class MotionLights extends Automation {
  async onStart() {
    this.subscribeToStateChangeEvent('binary_sensor.hallway_motion', async (data) => {
      if (data.new_state?.state === 'on') {
        await this.callService('light', 'turn_on', {
          entity_id: 'light.hallway',
          brightness: 200,
        });
        this.log('Hallway light on — motion detected');
      } else if (data.new_state?.state === 'off') {
        await this.callService('light', 'turn_off', {
          entity_id: 'light.hallway',
        });
        this.log('Hallway light off — motion cleared');
      }
    });
  }
}

export async function onInit() {
  const auto = new MotionLights();
  registerAutomation(auto);
  startAutomation(auto);
}
```

### 2. Door/Window Open Notification

Send a notification when a contact sensor opens.

```typescript
import { Automation, registerAutomation, startAutomation } from 'tae';

class DoorNotifier extends Automation {
  async onStart() {
    this.subscribeToStateChangeEvent('binary_sensor.front_door', async (data) => {
      if (data.old_state?.state === 'off' && data.new_state?.state === 'on') {
        await this.callService('notify', 'mobile_app_phone', {
          message: 'Front door was opened',
          title: 'Door Alert',
        });
        this.log('Front door open notification sent');
      }
    });
  }
}

export async function onInit() {
  const auto = new DoorNotifier();
  registerAutomation(auto);
  startAutomation(auto);
}
```

### 3. Temperature-Based Climate Control

Adjust HVAC based on a temperature sensor.

```typescript
import { Automation, registerAutomation, startAutomation } from 'tae';

class TemperatureControl extends Automation {
  async onStart() {
    this.subscribeToStateChangeEvent('sensor.living_room_temperature', async (data) => {
      const temp = parseFloat(data.new_state?.state ?? '0');
      if (temp > 25) {
        await this.callService('climate', 'set_hvac_mode', {
          entity_id: 'climate.living_room',
          hvac_mode: 'cool',
        });
        this.log(`Too hot (${temp}°C) — cooling on`);
      } else if (temp < 20) {
        await this.callService('climate', 'set_hvac_mode', {
          entity_id: 'climate.living_room',
          hvac_mode: 'heat',
        });
        this.log(`Too cold (${temp}°C) — heating on`);
      }
    });
  }
}

export async function onInit() {
  const auto = new TemperatureControl();
  registerAutomation(auto);
  startAutomation(auto);
}
```

### 4. Debounced/Delayed Action

Turn off a light 5 minutes after motion clears, canceling if motion is re-detected.

```typescript
import { Automation, registerAutomation, startAutomation } from 'tae';

class MotionLightsDelayed extends Automation {
  private offTimer: ReturnType<typeof setTimeout> | null = null;

  async onStart() {
    this.subscribeToStateChangeEvent('binary_sensor.kitchen_motion', async (data) => {
      if (data.new_state?.state === 'on') {
        // Motion detected — cancel any pending off timer
        if (this.offTimer) {
          clearTimeout(this.offTimer);
          this.offTimer = null;
        }
        await this.callService('light', 'turn_on', {
          entity_id: 'light.kitchen',
          brightness: 255,
        });
      } else if (data.new_state?.state === 'off') {
        // Motion cleared — start 5-minute off timer
        this.offTimer = setTimeout(async () => {
          await this.callService('light', 'turn_off', {
            entity_id: 'light.kitchen',
          });
          this.log('Kitchen light off after 5min timeout');
          this.offTimer = null;
        }, 5 * 60 * 1000);
      }
    });
  }

  async onStop() {
    if (this.offTimer) {
      clearTimeout(this.offTimer);
      this.offTimer = null;
    }
  }
}

export async function onInit() {
  const auto = new MotionLightsDelayed();
  registerAutomation(auto);
  startAutomation(auto);
}
```

### 5. Multi-Entity Monitoring

Track multiple sensors and act when any triggers.

```typescript
import { Automation, registerAutomation, startAutomation } from 'tae';

class LeakDetector extends Automation {
  private sensors = [
    'binary_sensor.kitchen_leak',
    'binary_sensor.bathroom_leak',
    'binary_sensor.laundry_leak',
  ];

  async onStart() {
    for (const sensor of this.sensors) {
      this.subscribeToStateChangeEvent(sensor, async (data) => {
        if (data.new_state?.state === 'on') {
          this.error(`Water leak detected: ${data.entity_id}`);
          await this.callService('notify', 'mobile_app_phone', {
            message: `Water leak at ${data.entity_id}!`,
            title: 'LEAK ALERT',
          });
          // Shut off water valve if available
          await this.callService('switch', 'turn_off', {
            entity_id: 'switch.water_main_valve',
          });
        }
      });
    }
  }
}

export async function onInit() {
  const auto = new LeakDetector();
  registerAutomation(auto);
  startAutomation(auto);
}
```

### 6. Presence-Based Automation with State Tracking

Use persistent storage to track state across restarts.

```typescript
import { Automation, registerAutomation, startAutomation } from 'tae';

class PresenceTracker extends Automation {
  async onStart() {
    this.subscribeToStateChangeEvent('person.john', async (data) => {
      const wasHome = data.old_state?.state === 'home';
      const isHome = data.new_state?.state === 'home';

      if (!wasHome && isHome) {
        // Just arrived home
        this.log('John arrived home');
        await this.storage.persistent.set('lastArrival', Date.now());
        await this.callService('scene', 'turn_on', {
          entity_id: 'scene.welcome_home',
        });
      } else if (wasHome && !isHome) {
        // Just left
        this.log('John left home');
        await this.callService('scene', 'turn_on', {
          entity_id: 'scene.away',
        });
      }
    });

    // Log how long ago last arrival was
    const lastArrival = await this.storage.persistent.get('lastArrival');
    if (lastArrival) {
      const mins = Math.round((Date.now() - lastArrival) / 60000);
      this.log(`Last arrival was ${mins} minutes ago`);
    }
  }
}

export async function onInit() {
  const auto = new PresenceTracker();
  registerAutomation(auto);
  startAutomation(auto);
}
```

### 7. Conditional Logic with Current State Check

Check other entities' state before acting.

```typescript
import { Automation, registerAutomation, startAutomation } from 'tae';

class SmartMotionLight extends Automation {
  async onStart() {
    this.subscribeToStateChangeEvent('binary_sensor.living_room_motion', async (data) => {
      if (data.new_state?.state !== 'on') return;

      // Only turn on light if it's dark outside
      const sun = await this.getEntityState('sun.sun');
      if (sun?.state !== 'below_horizon') {
        this.debug('Motion detected but sun is up — skipping');
        return;
      }

      // Only if light is currently off
      const light = await this.getEntityState('light.living_room');
      if (light?.state === 'on') {
        this.debug('Motion detected but light already on — skipping');
        return;
      }

      await this.callService('light', 'turn_on', {
        entity_id: 'light.living_room',
        brightness: 180,
        color_temp: 370,
      });
      this.log('Living room light on — motion + dark');
    });
  }
}

export async function onInit() {
  const auto = new SmartMotionLight();
  registerAutomation(auto);
  startAutomation(auto);
}
```

### 8. Multiple Automations in One File

```typescript
import { Automation, registerAutomation, startAutomation } from 'tae';

class NightLight extends Automation {
  async onStart() {
    this.subscribeToStateChangeEvent('binary_sensor.bedroom_motion', async (data) => {
      if (data.new_state?.state === 'on') {
        await this.callService('light', 'turn_on', {
          entity_id: 'light.bedroom_night',
          brightness: 30,
        });
      }
    });
  }
}

class MorningRoutine extends Automation {
  async onStart() {
    this.subscribeToEvent('timer.finished', async (event) => {
      if (event.data.entity_id === 'timer.morning_alarm') {
        await this.callService('light', 'turn_on', {
          entity_id: 'light.bedroom',
          brightness: 255,
          color_temp: 250,
        });
        await this.callService('media_player', 'set_volume_level', {
          entity_id: 'media_player.bedroom_speaker',
          volume_level: 0.3,
        });
      }
    });
  }
}

export async function onInit() {
  const nightLight = new NightLight();
  registerAutomation(nightLight);
  startAutomation(nightLight);

  const morning = new MorningRoutine();
  registerAutomation(morning);
  startAutomation(morning);
}
```

## Do's and Don'ts

### Do:
- Always export `onInit()` from every automation file
- Always call `registerAutomation()` then `startAutomation()` in `onInit()`
- Add a file-level comment at the top of each file describing what the file contains and its purpose
- Add a thorough JSDoc description above each automation class explaining what it does, what entities it interacts with, and its behavior
- Use `subscribeToStateChangeEvent` for entity-specific state monitoring (most common)
- Use `subscribeToEvent` only for non-state events (ZHA, timers, etc.)
- Use `getEntityState` for quick state lookups before acting
- Use `this.log()` / `this.debug()` for observability
- Use persistent storage for values that must survive restarts
- Use temp storage for caches and debounce flags
- Clean up timers and intervals in `onStop()`
- Check `old_state` and `new_state` for null before accessing `.state`
- Parse numeric sensor states with `parseFloat(state.state)`
- Use guard clauses (`if (condition) return;`) to keep callbacks clean

### Don't:
- Don't forget to export `onInit()` — the file won't load without it
- Don't omit class or file descriptions — every automation class needs a JSDoc comment and every file needs a top-level comment describing its purpose (this enables AI-assisted editing later)
- Don't use `onStateChange` unless you truly need ALL entity changes — it fires constantly
- Don't create infinite loops (e.g., reacting to a state you're setting)
- Don't block the event loop with synchronous long-running operations
- Don't store class instances or functions in storage — only JSON-serializable values
- Don't manually unsubscribe in `onStop()` — subscriptions are auto-cleaned
- Don't call `startAutomation()` before `registerAutomation()`
- Don't use `fetchEntityState` inside high-frequency callbacks — use `getEntityState` instead

## Entity ID Format

Entity IDs in Home Assistant follow the pattern: `domain.object_id`

Common domains:
- `light.*` — Lights
- `switch.*` — Switches and smart plugs
- `binary_sensor.*` — On/off sensors (motion, door, leak, etc.)
- `sensor.*` — Numeric/text sensors (temperature, humidity, power, etc.)
- `climate.*` — HVAC / thermostats
- `cover.*` — Blinds, garage doors
- `media_player.*` — Speakers, TVs
- `person.*` — Person tracking
- `input_boolean.*` — Helper toggles
- `input_number.*` — Helper numbers
- `input_select.*` — Helper dropdowns
- `input_text.*` — Helper text fields
- `automation.*` — Native HA automations
- `scene.*` — Scenes
- `script.*` — Scripts
- `fan.*` — Fans
- `lock.*` — Locks
- `vacuum.*` — Robot vacuums
- `camera.*` — Cameras
- `sun.sun` — Sun state (above_horizon / below_horizon)

## Imports Cheat Sheet

```typescript
// Everything you might need from TAE:
import {
  Automation,                      // Base class to extend
  registerAutomation,              // Register with engine
  startAutomation,                 // Start an automation
  stopAutomation,                  // Stop an automation
  callService,                     // Standalone service call
  subscribeToEvent,                // Standalone event subscription
  subscribeToStateChangeEvent,     // Standalone state subscription
  onStateChange,                   // Standalone all-state subscription
  getEntityState,                  // Read entity state from cache (sync)
  fetchEntityState,                // Fetch entity state from HA API (async)
  log, warn, error, debug,         // Standalone logging
  LogLevel,                        // LogLevel.Debug, .Info, .Warn, .Error
  // Types (for type annotations):
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
} from 'tae';
```
