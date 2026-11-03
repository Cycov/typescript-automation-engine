/**
 * Claude via the official Anthropic SDK — chat turns (streaming, tools,
 * prompt caching) and inline completions.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  ChatProvider,
  CompletionProvider,
  EffortLevel,
  GenerateResult,
  ProviderError,
  StopReason,
  ToolResultItem,
  ToolSpec,
  TurnCallbacks,
  TurnResult,
} from "./types";

const CHAT_MAX_TOKENS = 32000;
const COMPLETION_MAX_TOKENS = 1024; //< leaves room for adaptive thinking before the answer
const UNPARSEABLE_TOOL_INPUT_RETRIES = 2;
const API_MAX_RETRIES = 2;
const COMPLETION_STOP_SEQUENCES = ["\n\n\n"];

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

/** model + effort pairs the API rejected (older models, unsupported levels); sent without effort afterwards. */
const rejectedEfforts = new Set<string>();

function describeError(err: InstanceType<typeof Anthropic.APIError>, model: string): string {
  const apiMessage: string | undefined = (err.error as any)?.error?.message;
  const detail = apiMessage || err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key (401). Check it in AI settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return `Anthropic denied the request (403): ${detail}`;
  if (err instanceof Anthropic.NotFoundError) return `Anthropic does not know model "${model}" (404). Choose a current model in AI settings.`;
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached (429). Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${err.message}`;
  return `Anthropic API error${err.status ? ` ${err.status}` : ""}: ${detail}`;
}

function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: API_MAX_RETRIES });
}

export class AnthropicChat implements ChatProvider {
  readonly key: string;
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = createClient(apiKey);
    this.model = model;
    this.key = `anthropic:${model}`;
  }

  pushUser(history: unknown[], text: string): void {
    (history as Anthropic.MessageParam[]).push({ role: "user", content: text });
  }

  pushToolResults(history: unknown[], results: ToolResultItem[]): void {
    (history as Anthropic.MessageParam[]).push({
      role: "user",
      content: results.map((result) => ({
        type: "tool_result" as const,
        tool_use_id: result.id,
        content: result.text,
        ...(result.isError ? { is_error: true } : {}),
      })),
    });
  }

  async runTurn(
    history: unknown[],
    system: string,
    tools: ToolSpec[],
    effort: EffortLevel,
    callbacks: TurnCallbacks,
    signal: AbortSignal
  ): Promise<TurnResult> {
    const messages = history as Anthropic.MessageParam[];
    const toolParams: Anthropic.Tool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      eager_input_streaming: true,
    }));

    for (let attempt = 0; ; attempt++) {
      try {
        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: CHAT_MAX_TOKENS,
            cache_control: { type: "ephemeral" }, //< caches the growing conversation prefix
            system: [{ type: "text", text: system }],
            tools: toolParams,
            messages,
            ...(effort ? { output_config: { effort } } : {}),
          },
          { signal }
        );
        stream.on("text", (delta) => callbacks.onText(delta));
        stream.on("streamEvent", (event) => {
          if (event.type === "content_block_start" && event.content_block.type === "thinking") {
            callbacks.onThinking();
          }
        });

        const message = await stream.finalMessage();
        messages.push({ role: "assistant", content: message.content });

        const toolCalls = message.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
          .map((block) => ({ id: block.id, name: block.name, input: block.input }));
        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
        return {
          text,
          toolCalls,
          stopReason: STOP_REASONS[message.stop_reason ?? ""] ?? "other",
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
          },
        };
      } catch (err: any) {
        if (err instanceof Anthropic.APIUserAbortError || signal.aborted) throw err;
        if (err instanceof Anthropic.BadRequestError && effort) {
          throw new ProviderError(`${describeError(err, this.model)} (chat effort "${effort}": if the model does not support it, pick another level in AI settings and start a new chat)`);
        }
        if (err instanceof Anthropic.APIError) throw new ProviderError(describeError(err, this.model));
        // Anything else is an eager-streamed tool input that could not be parsed: re-issue the turn
        if (attempt >= UNPARSEABLE_TOOL_INPUT_RETRIES) {
          throw new ProviderError(`Claude's tool call could not be parsed: ${err?.message ?? err}`);
        }
      }
    }
  }
}

export class AnthropicCompletion implements CompletionProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = createClient(apiKey);
    this.model = model;
  }

  async complete(system: string, user: string, effort: EffortLevel, signal: AbortSignal): Promise<string> {
    try {
      return (await this.run(system, user, effort, signal, COMPLETION_MAX_TOKENS, COMPLETION_STOP_SEQUENCES)).text;
    } catch (err: any) {
      if (err instanceof Anthropic.APIUserAbortError || signal.aborted) return "";
      throw err;
    }
  }

  generate(system: string, user: string, maxTokens: number, effort: EffortLevel, signal: AbortSignal): Promise<GenerateResult> {
    return this.run(system, user, effort, signal, maxTokens);
  }

  private async run(
    system: string,
    user: string,
    effort: EffortLevel,
    signal: AbortSignal,
    maxTokens: number,
    stopSequences?: string[]
  ): Promise<GenerateResult> {
    const rejectedKey = `${this.model}\u0000${effort}`;
    const sentEffort: EffortLevel = rejectedEfforts.has(rejectedKey) ? "" : effort;
    try {
      return await this.request(system, user, signal, sentEffort, maxTokens, stopSequences);
    } catch (err: any) {
      if (err instanceof Anthropic.APIUserAbortError || signal.aborted) throw err;
      if (sentEffort && err instanceof Anthropic.BadRequestError) {
        // The model rejects this effort level; remember that only if the plain request works
        try {
          const result = await this.request(system, user, signal, "", maxTokens, stopSequences);
          rejectedEfforts.add(rejectedKey);
          return result;
        } catch {}
      }
      if (err instanceof Anthropic.APIError) throw new ProviderError(describeError(err, this.model));
      throw err;
    }
  }

  private async request(
    system: string,
    user: string,
    signal: AbortSignal,
    effort: EffortLevel,
    maxTokens: number,
    stopSequences?: string[]
  ): Promise<GenerateResult> {
    const message = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        ...(stopSequences ? { stop_sequences: stopSequences } : {}),
        ...(effort ? { output_config: { effort } } : {}),
      },
      { signal }
    );
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const client = createClient(apiKey);
  const ids: string[] = [];
  try {
    for await (const model of client.models.list()) {
      ids.push(model.id);
    }
  } catch (err: any) {
    if (err instanceof Anthropic.APIError) throw new ProviderError(describeError(err, ""));
    throw err;
  }
  return ids;
}
