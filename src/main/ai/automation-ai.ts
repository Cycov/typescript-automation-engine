/**
 * Text generation for automations (this.ai.generate) with the provider and key
 * from TAE's AI settings. Logs each request's cost and limits requests per
 * automation, so a runaway loop can't spend the credits.
 */

import { Logger } from "../logging";
import { AISettings } from "./config";
import { turnCostUsd } from "./pricing";
import { createCompletionProvider } from "./providers";

const DEFAULT_SYSTEM = "You write short texts for a smart home. Answer with the text only, no preamble.";
const DEFAULT_MAX_TOKENS = 500;
const MAX_TOKENS_LIMIT = 4000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_PROMPT_CHARS = 20000;
const MAX_REQUESTS_PER_HOUR = 30; //< per automation
const HOUR_MS = 60 * 60 * 1000;
const COST_DECIMALS = 5;

export interface AutomationAIRequest {
  automationId: string;
  prompt: string;
  options?: {
    system?: string;
    model?: "fast" | "smart";
    maxTokens?: number;
    timeoutMs?: number;
  };
}

function clamp(value: unknown, fallback: number, max: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, max);
}

export class AutomationAI {
  private settings: AISettings;
  private logger: Logger;
  private requestTimes = new Map<string, number[]>(); // automationId → request times in the last hour

  constructor(settings: AISettings, logger: Logger) {
    this.settings = settings;
    this.logger = logger;
  }

  async generate(request: AutomationAIRequest): Promise<string> {
    const { automationId } = request;
    const options = request.options ?? {};
    const prompt = String(request.prompt ?? "");
    if (!prompt.trim()) throw new Error("this.ai.generate: the prompt is empty");
    if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`this.ai.generate: the prompt is longer than ${MAX_PROMPT_CHARS} characters`);

    const config = this.settings.get();
    if (!this.settings.isConfigured(config)) throw new Error("AI is not set up: choose a provider and API key in TAE's AI settings");
    this.countRequest(automationId);

    const smart = options.model === "smart";
    const model = smart ? this.settings.chatModel(config) : this.settings.automationModel(config);
    const effort = smart ? config.chatEffort : this.settings.automationEffort(config);
    const maxTokens = clamp(options.maxTokens, DEFAULT_MAX_TOKENS, MAX_TOKENS_LIMIT);
    const timeoutMs = clamp(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const system = typeof options.system === "string" && options.system.trim() ? options.system : DEFAULT_SYSTEM;

    const signal = AbortSignal.timeout(timeoutMs);
    let result;
    try {
      result = await createCompletionProvider(config, model).generate(system, prompt, maxTokens, effort, signal);
    } catch (err: any) {
      if (signal.aborted) throw new Error(`AI request timed out after ${timeoutMs} ms`);
      throw new Error(`AI request failed: ${err?.message ?? err}`);
    }
    const cost = turnCostUsd(model, result.usage);
    const costText = cost !== undefined ? `, ~$${cost.toFixed(COST_DECIMALS)}` : "";
    this.logger.log("info", automationId, `AI text from ${model} (${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens${costText})`);
    const text = result.text.trim();
    if (!text) throw new Error(`AI returned no text (${model})`);
    return text;
  }

  private countRequest(automationId: string): void {
    const now = Date.now();
    const recent = (this.requestTimes.get(automationId) ?? []).filter((time) => now - time < HOUR_MS);
    if (recent.length >= MAX_REQUESTS_PER_HOUR) {
      this.requestTimes.set(automationId, recent);
      throw new Error(`AI request limit reached: ${MAX_REQUESTS_PER_HOUR} per hour per automation`);
    }
    recent.push(now);
    this.requestTimes.set(automationId, recent);
  }
}
