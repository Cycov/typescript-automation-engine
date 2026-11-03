/**
 * Provider-neutral types for the chat agent and inline completions.
 * Each provider keeps the conversation history in its own wire format.
 */

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Set when the provider could not parse the tool input. */
  inputError?: string;
}

export interface ToolResultItem {
  id: string;
  text: string;
  isError: boolean;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

/** How hard the model thinks. "" = the model's own default (nothing is sent). */
export type EffortLevel = "" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: EffortLevel[] = ["", "low", "medium", "high", "xhigh", "max"];

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: TurnUsage;
}

export interface TurnCallbacks {
  onText: (delta: string) => void;
  onThinking: () => void;
}

export interface ChatProvider {
  /** provider + model; a session is bound to one key. */
  readonly key: string;
  pushUser(history: unknown[], text: string): void;
  pushToolResults(history: unknown[], results: ToolResultItem[]): void;
  /** Run one model turn; appends the assistant message to history. */
  runTurn(
    history: unknown[],
    system: string,
    tools: ToolSpec[],
    effort: EffortLevel,
    callbacks: TurnCallbacks,
    signal: AbortSignal
  ): Promise<TurnResult>;
}

export interface GenerateResult {
  text: string;
  usage: TurnUsage;
}

export interface CompletionProvider {
  complete(system: string, user: string, effort: EffortLevel, signal: AbortSignal): Promise<string>;
  /** Plain text generation (automations' this.ai.generate). Rejects on abort. */
  generate(system: string, user: string, maxTokens: number, effort: EffortLevel, signal: AbortSignal): Promise<GenerateResult>;
}

/** An error whose message is safe and useful to show the user. */
export class ProviderError extends Error {}

export function emptyUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(total: TurnUsage, turn: TurnUsage): void {
  total.inputTokens += turn.inputTokens;
  total.outputTokens += turn.outputTokens;
  total.cacheReadTokens += turn.cacheReadTokens;
  total.cacheWriteTokens += turn.cacheWriteTokens;
}
