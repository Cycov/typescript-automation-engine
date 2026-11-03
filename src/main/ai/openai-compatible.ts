/**
 * OpenAI-compatible chat completions (OpenAI, GitHub Models, DeepSeek):
 * streaming with function calling, plus inline completions.
 */

import {
  ChatProvider,
  CompletionProvider,
  EffortLevel,
  GenerateResult,
  ProviderError,
  StopReason,
  ToolCall,
  ToolResultItem,
  ToolSpec,
  TurnCallbacks,
  TurnResult,
} from "./types";

export type OpenAICompatibleId = "openai" | "github" | "deepseek";

const BASE_URLS: Record<OpenAICompatibleId, string> = {
  github: "https://models.github.ai/inference",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
};
const GITHUB_CATALOG_URL = "https://models.github.ai/catalog/models";
const BASE_URL_OVERRIDE = process.env.TAE_OPENAI_COMPATIBLE_BASE_URL || ""; //< development: point at a local server
const LABELS: Record<OpenAICompatibleId, string> = { github: "GitHub Models", openai: "OpenAI", deepseek: "DeepSeek" };

const DEEPSEEK_CHAT_MAX_TOKENS = 8192; //< DeepSeek's default (4096) is too small for file writes
const COMPLETION_MAX_TOKENS = 512;
const ERROR_BODY_MAX_CHARS = 800;
const LIST_MODELS_TIMEOUT_MS = 15000;
const HTTP_BAD_REQUEST = 400;

/** OpenAI's reasoning_effort tops out at "high". */
const REASONING_EFFORT: Record<Exclude<EffortLevel, "">, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** model + effort pairs rejected with a 400 (non-reasoning models); sent without effort afterwards. */
const rejectedEfforts = new Set<string>();

const STOP_REASONS: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

async function errorFromResponse(label: string, res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  return new ProviderError(`${label} API ${res.status}: ${body.slice(0, ERROR_BODY_MAX_CHARS)}`);
}

function effortField(effort: EffortLevel): Record<string, string> {
  return effort ? { reasoning_effort: REASONING_EFFORT[effort] } : {};
}

/**
 * POST a chat completion with reasoning_effort; a model that rejects it (400)
 * is retried without it, and remembered if that works.
 */
async function postChatCompletion(
  provider: OpenAICompatibleId,
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  effort: EffortLevel,
  signal: AbortSignal
): Promise<Response> {
  const rejectedKey = `${provider}\u0000${model}\u0000${effort}`;
  const sentEffort: EffortLevel = rejectedEfforts.has(rejectedKey) ? "" : effort;
  const post = (withEffort: EffortLevel) =>
    fetch(`${BASE_URL_OVERRIDE || BASE_URLS[provider]}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, ...body, ...effortField(withEffort) }),
      signal,
    });
  const res = await post(sentEffort);
  if (res.status !== HTTP_BAD_REQUEST || !sentEffort) return res;
  await res.body?.cancel().catch(() => {});
  const retry = await post("");
  if (!retry.ok) return retry;
  rejectedEfforts.add(rejectedKey);
  return retry;
}

/** DeepSeek uses `max_tokens`; newer OpenAI models use `max_completion_tokens`. */
function tokenLimit(provider: OpenAICompatibleId, limit: number): Record<string, number> {
  return provider === "deepseek" ? { max_tokens: limit } : { max_completion_tokens: limit };
}

export class OpenAICompatibleChat implements ChatProvider {
  readonly key: string;
  private provider: OpenAICompatibleId;
  private apiKey: string;
  private model: string;

  constructor(provider: OpenAICompatibleId, apiKey: string, model: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model;
    this.key = `${provider}:${model}`;
  }

  pushUser(history: unknown[], text: string): void {
    history.push({ role: "user", content: text });
  }

  pushToolResults(history: unknown[], results: ToolResultItem[]): void {
    for (const result of results) {
      history.push({ role: "tool", tool_call_id: result.id, content: result.isError ? `Error: ${result.text}` : result.text });
    }
  }

  async runTurn(
    history: unknown[],
    system: string,
    tools: ToolSpec[],
    effort: EffortLevel,
    callbacks: TurnCallbacks,
    signal: AbortSignal
  ): Promise<TurnResult> {
    const label = LABELS[this.provider];
    const body = {
      messages: [{ role: "system", content: system }, ...history],
      tools: tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
      stream: true,
      stream_options: { include_usage: true },
      ...(this.provider === "deepseek" ? tokenLimit(this.provider, DEEPSEEK_CHAT_MAX_TOKENS) : {}),
    };
    const res = await postChatCompletion(this.provider, this.apiKey, this.model, body, effort, signal);
    if (!res.ok) throw await errorFromResponse(label, res);
    if (!res.body) throw new ProviderError(`${label} returned no response body`);

    let text = "";
    let finishReason = "";
    const pending: PendingToolCall[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice("data:".length).trim();
          if (!data || data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            text += delta.content;
            callbacks.onText(delta.content);
          }
          if (delta?.reasoning_content) {
            callbacks.onThinking();
          }
          for (const toolDelta of delta?.tool_calls || []) {
            const slot = toolDelta.index ?? pending.length;
            if (!pending[slot]) pending[slot] = { id: "", name: "", args: "" };
            if (toolDelta.id) pending[slot].id = toolDelta.id;
            if (toolDelta.function?.name) pending[slot].name += toolDelta.function.name;
            if (toolDelta.function?.arguments) pending[slot].args += toolDelta.function.arguments;
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0;
            usage.cacheReadTokens = cached;
            usage.inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached); //< prompt_tokens includes cached ones
            usage.outputTokens = chunk.usage.completion_tokens ?? 0;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const calls = pending.filter(Boolean);
    calls.forEach((call, iCall) => {
      if (!call.id) call.id = `call_${Date.now()}_${iCall}`;
    });
    history.push({
      role: "assistant",
      content: text || null,
      ...(calls.length
        ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args } })) }
        : {}),
    });

    const toolCalls: ToolCall[] = calls.map((call) => {
      try {
        return { id: call.id, name: call.name, input: call.args ? JSON.parse(call.args) : {} };
      } catch {
        return { id: call.id, name: call.name, input: undefined, inputError: call.args };
      }
    });
    return { text, toolCalls, stopReason: STOP_REASONS[finishReason] ?? (toolCalls.length ? "tool_use" : "other"), usage };
  }
}

export class OpenAICompatibleCompletion implements CompletionProvider {
  private provider: OpenAICompatibleId;
  private apiKey: string;
  private model: string;

  constructor(provider: OpenAICompatibleId, apiKey: string, model: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(system: string, user: string, effort: EffortLevel, signal: AbortSignal): Promise<string> {
    try {
      const body = {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...tokenLimit(this.provider, COMPLETION_MAX_TOKENS),
      };
      const res = await postChatCompletion(this.provider, this.apiKey, this.model, body, effort, signal);
      if (!res.ok) throw await errorFromResponse(LABELS[this.provider], res);
      const data = (await res.json()) as any;
      return data.choices?.[0]?.message?.content || "";
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) return "";
      throw err;
    }
  }

  async generate(system: string, user: string, maxTokens: number, effort: EffortLevel, signal: AbortSignal): Promise<GenerateResult> {
    const body = {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...tokenLimit(this.provider, maxTokens),
    };
    const res = await postChatCompletion(this.provider, this.apiKey, this.model, body, effort, signal);
    if (!res.ok) throw await errorFromResponse(LABELS[this.provider], res);
    const data = (await res.json()) as any;
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.prompt_cache_hit_tokens ?? 0;
    return {
      text: data.choices?.[0]?.message?.content || "",
      usage: {
        inputTokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached), //< prompt_tokens includes cached ones
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  }
}

export async function listOpenAICompatibleModels(provider: OpenAICompatibleId, apiKey: string): Promise<string[]> {
  const url = provider === "github" ? GITHUB_CATALOG_URL : `${BASE_URLS[provider]}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
  });
  if (!res.ok) throw await errorFromResponse(LABELS[provider], res);
  const data = (await res.json()) as any;
  const entries: any[] = Array.isArray(data) ? data : data.data || [];
  return entries.map((entry) => entry.id).filter(Boolean).sort();
}
