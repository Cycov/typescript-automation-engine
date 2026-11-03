/**
 * Approximate cost of a model turn in USD, for the chat's usage badge.
 * Prices per million tokens from the Claude API documentation (2026-11);
 * models without a known price show tokens only.
 */

import { TurnUsage } from "./types";

const TOKENS_PER_MILLION = 1_000_000;
const CACHE_WRITE_MULTIPLIER = 1.25; //< 5-minute cache writes
const HAIKU_LONG_PROMPT_TOKENS = 100_000; //< Haiku 5.5 charges more above this prompt size

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Prices when the prompt exceeds longPromptTokens. */
  longPrompt?: { tokens: number; input: number; output: number; cacheRead: number };
}

/** Longest prefix wins, so dated ids ("claude-opus-5-5-2026...") match too. */
const PRICES: Array<[string, ModelPrice]> = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  [
    "claude-haiku-5-5",
    { input: 0.1, output: 0.5, cacheRead: 0.01, longPrompt: { tokens: HAIKU_LONG_PROMPT_TOKENS, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  ],
];

function priceFor(model: string): ModelPrice | undefined {
  let best: [string, ModelPrice] | undefined;
  for (const entry of PRICES) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}

/** Cost of one request, or undefined when the model's price is unknown. */
export function turnCostUsd(model: string, usage: TurnUsage): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const rates = price.longPrompt && promptTokens > price.longPrompt.tokens ? price.longPrompt : price;
  return (
    (usage.inputTokens * rates.input +
      usage.cacheWriteTokens * rates.input * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * rates.cacheRead +
      usage.outputTokens * rates.output) /
    TOKENS_PER_MILLION
  );
}
