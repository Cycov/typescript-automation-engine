/**
 * TAE — Default Automations Entry Point
 *
 * This is the main entry point for your automations.
 * All automations must be instantiated, registered, and started here.
 *
 * Example:
 *
 *   import { Automation, registerAutomation, startAutomation } from 'tae';
 *
 *   class MyAutomation extends Automation {
 *     async onStart() {
 *       this.log('Started!');
 *       this.subscribeToStateChangeEvent('binary_sensor.motion', async (data) => {
 *         if (data.new_state?.state === 'on') {
 *           await this.callService('light', 'turn_on', { entity_id: 'light.living_room' });
 *         }
 *       });
 *     }
 *     async onStop() {
 *       this.log('Stopped!');
 *     }
 *   }
 *
 *   export function onInit() {
 *     const auto = new MyAutomation();
 *     registerAutomation(auto);
 *     startAutomation(auto);
 *   }
 */

import { Automation, registerAutomation, startAutomation } from 'tae';

class HelloWorldAutomation extends Automation {
  async onStart() {
    this.log('Hello from TypeScript Automation Engine!');
    this.log(`Automation ${this.id} is now running.`);
  }

  async onStop() {
    this.log(`Automation ${this.id} stopped.`);
  }
}

export function onInit() {
  const hello = new HelloWorldAutomation();
  registerAutomation(hello);
  startAutomation(hello);
}
