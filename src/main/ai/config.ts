/**
 * AI settings — add-on options as the starting point, overridden by what the
 * user saves in the TAE settings dialog (persisted in the settings table).
 */

import { Storage } from "../storage";
import { EFFORT_LEVELS, EffortLevel } from "./types";

export type ProviderId = "none" | "github" | "openai" | "anthropic" | "deepseek";

export const PROVIDER_IDS: ProviderId[] = ["none", "github", "openai", "anthropic", "deepseek"];

/** What the add-on options can set. */
export interface AIOptions {
  provider: ProviderId;
  apiKey: string;
  model: string;
  completionModel: string;
}

export interface AIConfig extends AIOptions {
  chatEffort: EffortLevel;
  completionEffort: EffortLevel;
}

const DEFAULT_CHAT_EFFORT: EffortLevel = ""; //< model default
const DEFAULT_COMPLETION_EFFORT: EffortLevel = "low"; //< completions must be fast

/** Used when the model fields are left empty. */
export const DEFAULT_MODELS: Record<ProviderId, { chat: string; completion: string }> = {
  none: { chat: "", completion: "" },
  anthropic: { chat: "claude-opus-5-5", completion: "claude-haiku-5-5" },
  openai: { chat: "", completion: "" },
  github: { chat: "", completion: "" },
  deepseek: { chat: "deepseek-chat", completion: "deepseek-chat" },
};

const SETTINGS_KEY = "ai_config";
const KEY_HINT_CHARS = 4;

export interface AIConfigInfo {
  provider: ProviderId;
  model: string;
  completionModel: string;
  defaultModel: string;
  defaultCompletionModel: string;
  chatEffort: EffortLevel;
  completionEffort: EffortLevel;
  configured: boolean;
  keySet: boolean;
  keyHint: string;
  savedInTae: boolean;
  defaults: Record<ProviderId, { chat: string; completion: string }>;
}

export class AISettings {
  private storage: Storage;
  private fromOptions: AIOptions;
  private saved: Partial<AIConfig> | undefined;

  constructor(storage: Storage, fromOptions: AIOptions) {
    this.storage = storage;
    this.fromOptions = fromOptions;
    this.saved = storage.getSetting<Partial<AIConfig>>(SETTINGS_KEY);
  }

  /** Effective settings: saved values win over add-on options. */
  get(): AIConfig {
    const merged: AIConfig = {
      chatEffort: DEFAULT_CHAT_EFFORT,
      completionEffort: DEFAULT_COMPLETION_EFFORT,
      ...this.fromOptions,
      ...(this.saved || {}),
    };
    if (!PROVIDER_IDS.includes(merged.provider)) merged.provider = "none";
    if (!EFFORT_LEVELS.includes(merged.chatEffort)) merged.chatEffort = DEFAULT_CHAT_EFFORT;
    if (!EFFORT_LEVELS.includes(merged.completionEffort)) merged.completionEffort = DEFAULT_COMPLETION_EFFORT;
    return merged;
  }

  /** Model to use for chat, falling back to the provider default. */
  chatModel(config: AIConfig = this.get()): string {
    return config.model || DEFAULT_MODELS[config.provider].chat;
  }

  /** Model for inline completions: completion model, provider default, then chat model. */
  completionModel(config: AIConfig = this.get()): string {
    return config.completionModel || DEFAULT_MODELS[config.provider].completion || this.chatModel(config);
  }

  isConfigured(config: AIConfig = this.get()): boolean {
    return config.provider !== "none" && !!config.apiKey && !!this.chatModel(config);
  }

  /** Persist a change. An empty or missing apiKey keeps the current key unless the provider changes. */
  update(change: Partial<AIConfig>): void {
    const current = this.get();
    const next: AIConfig = {
      provider: change.provider ?? current.provider,
      model: change.model ?? current.model,
      completionModel: change.completionModel ?? current.completionModel,
      chatEffort: change.chatEffort ?? current.chatEffort,
      completionEffort: change.completionEffort ?? current.completionEffort,
      apiKey: current.apiKey,
    };
    if (change.apiKey) {
      next.apiKey = change.apiKey;
    } else if (next.provider !== current.provider) {
      next.apiKey = "";
    }
    this.saved = next;
    this.storage.setSetting(SETTINGS_KEY, next);
  }

  info(): AIConfigInfo {
    const config = this.get();
    return {
      provider: config.provider,
      model: config.model,
      completionModel: config.completionModel,
      defaultModel: DEFAULT_MODELS[config.provider].chat,
      defaultCompletionModel: DEFAULT_MODELS[config.provider].completion,
      chatEffort: config.chatEffort,
      completionEffort: config.completionEffort,
      configured: this.isConfigured(config),
      keySet: !!config.apiKey,
      keyHint: config.apiKey ? `…${config.apiKey.slice(-KEY_HINT_CHARS)}` : "",
      savedInTae: !!this.saved,
      defaults: DEFAULT_MODELS,
    };
  }
}
