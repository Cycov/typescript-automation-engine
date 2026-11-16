/**
 * Secrets: name → value pairs (API keys, passwords) set in the UI's Secrets tab and read by
 * automations with getSecret(). Kept in TAE's database, outside the workspace and its git history.
 */

import { Storage } from "./storage";

const SETTINGS_KEY = "secrets";
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const NAME_MAX_CHARS = 64;
const VALUE_MAX_CHARS = 8000;

export type SecretValues = Record<string, string>;

export class Secrets {
  private storage: Storage;
  private values: SecretValues;
  private listeners: Array<(values: SecretValues) => void> = [];

  constructor(storage: Storage) {
    this.storage = storage;
    this.values = storage.getSetting<SecretValues>(SETTINGS_KEY) ?? {};
  }

  all(): SecretValues {
    return { ...this.values };
  }

  names(): string[] {
    return Object.keys(this.values).sort((left, right) => left.localeCompare(right));
  }

  set(name: string, value: string): void {
    if (!NAME_PATTERN.test(name) || name.length > NAME_MAX_CHARS) {
      throw new Error(`Invalid secret name "${name}": use letters, digits, _ . and - (at most ${NAME_MAX_CHARS} characters)`);
    }
    if (!value) throw new Error(`Secret "${name}" needs a value`);
    if (value.length > VALUE_MAX_CHARS) throw new Error(`Secret "${name}" is longer than ${VALUE_MAX_CHARS} characters`);
    this.values[name] = value;
    this.save();
  }

  /** Returns false when there was no such secret. */
  delete(name: string): boolean {
    if (!(name in this.values)) return false;
    delete this.values[name];
    this.save();
    return true;
  }

  onChange(listener: (values: SecretValues) => void): void {
    this.listeners.push(listener);
  }

  private save(): void {
    this.storage.setSetting(SETTINGS_KEY, this.values);
    for (const listener of this.listeners) listener(this.all());
  }
}
