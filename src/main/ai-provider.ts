/**
 * AI Provider — Proxies requests to GitHub Models (OpenAI-compatible) or other LLM APIs.
 * Supports streaming for chat and non-streaming for inline completions.
 */

export interface AIConfig {
  provider: "none" | "github" | "openai" | "anthropic";
  apiKey: string;
  model: string;
  completionModel: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CompletionRequest {
  prefix: string;
  suffix: string;
  filePath: string;
  otherFiles?: Array<{ path: string; content: string }>;
  entityContext?: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  systemContext?: string;
}

interface StreamCallbacks {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

const PROVIDER_URLS: Record<string, string> = {
  github: "https://models.inference.ai.azure.com",
  openai: "https://api.openai.com/v1",
};

export class AIProvider {
  private config: AIConfig;
  private activeAbort: AbortController | null = null;

  constructor(config: AIConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return this.config.provider !== "none" && !!this.config.apiKey && !!this.config.model;
  }

  getInfo(): { provider: string; model: string; completionModel: string; configured: boolean } {
    return {
      provider: this.config.provider,
      model: this.config.model,
      completionModel: this.config.completionModel || this.config.model,
      configured: this.isConfigured(),
    };
  }

  updateConfig(config: Partial<AIConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Inline completion — returns a single completion string.
   * Uses a smaller/faster model by default for low latency.
   */
  async complete(req: CompletionRequest): Promise<string> {
    if (!this.isConfigured()) return "";

    if (this.config.provider === "anthropic") {
      return this.completeAnthropic(req);
    }

    // OpenAI-compatible (GitHub Models, OpenAI)
    return this.completeOpenAI(req);
  }

  /**
   * Chat — streams the response back via callbacks.
   */
  async chat(req: ChatRequest, callbacks: StreamCallbacks): Promise<void> {
    if (!this.isConfigured()) {
      callbacks.onError("AI not configured");
      return;
    }

    if (this.config.provider === "anthropic") {
      return this.chatAnthropic(req, callbacks);
    }

    return this.chatOpenAI(req, callbacks);
  }

  /**
   * Cancel any in-flight request.
   */
  cancel(): void {
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
  }

  // ─── OpenAI-compatible (GitHub Models, OpenAI) ─────

  private async completeOpenAI(req: CompletionRequest): Promise<string> {
    const baseUrl = PROVIDER_URLS[this.config.provider] || PROVIDER_URLS.openai;
    const model = this.config.completionModel || this.config.model;

    const systemPrompt = this.buildCompletionSystemPrompt();
    const userPrompt = this.buildCompletionUserPrompt(req);

    const controller = new AbortController();
    this.activeAbort = controller;

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_completion_tokens: 256,
          stop: ["\n\n\n", "```"],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`AI API ${res.status}: ${body.slice(0, 800)}`);
      }

      const data = await res.json() as any;
      return (data.choices?.[0]?.message?.content || "").trim();
    } catch (e: any) {
      if (e.name === "AbortError") return "";
      throw e;
    } finally {
      this.activeAbort = null;
    }
  }

  private async chatOpenAI(req: ChatRequest, callbacks: StreamCallbacks): Promise<void> {
    const baseUrl = PROVIDER_URLS[this.config.provider] || PROVIDER_URLS.openai;

    const messages: ChatMessage[] = [];
    if (req.systemContext) {
      messages.push({ role: "system", content: req.systemContext });
    }
    messages.push(...req.messages);

    const controller = new AbortController();
    this.activeAbort = controller;

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_completion_tokens: 4096,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        callbacks.onError(`AI API ${res.status}: ${body.slice(0, 800)}`);
        return;
      }

      await this.readSSEStream(res, callbacks);
    } catch (e: any) {
      if (e.name === "AbortError") {
        callbacks.onDone();
      } else {
        callbacks.onError(e.message);
      }
    } finally {
      this.activeAbort = null;
    }
  }

  private async readSSEStream(res: Response, callbacks: StreamCallbacks): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) {
      callbacks.onError("No response body");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            callbacks.onDone();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              callbacks.onChunk(content);
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    callbacks.onDone();
  }

  // ─── Anthropic ─────────────────────────────────────

  private async completeAnthropic(req: CompletionRequest): Promise<string> {
    const systemPrompt = this.buildCompletionSystemPrompt();
    const userPrompt = this.buildCompletionUserPrompt(req);
    const model = this.config.completionModel || this.config.model;

    const controller = new AbortController();
    this.activeAbort = controller;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          max_tokens: 256,
          temperature: 0.1,
          stop_sequences: ["\n\n\n", "```"],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic ${res.status}: ${body.slice(0, 800)}`);
      }

      const data = await res.json() as any;
      return (data.content?.[0]?.text || "").trim();
    } catch (e: any) {
      if (e.name === "AbortError") return "";
      throw e;
    } finally {
      this.activeAbort = null;
    }
  }

  private async chatAnthropic(req: ChatRequest, callbacks: StreamCallbacks): Promise<void> {
    const messages = req.messages.filter((m) => m.role !== "system");

    const controller = new AbortController();
    this.activeAbort = controller;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          system: req.systemContext || "",
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: 4096,
          temperature: 0.3,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        callbacks.onError(`Anthropic ${res.status}: ${body.slice(0, 800)}`);
        return;
      }

      await this.readAnthropicStream(res, callbacks);
    } catch (e: any) {
      if (e.name === "AbortError") {
        callbacks.onDone();
      } else {
        callbacks.onError(e.message);
      }
    } finally {
      this.activeAbort = null;
    }
  }

  private async readAnthropicStream(res: Response, callbacks: StreamCallbacks): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) {
      callbacks.onError("No response body");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          try {
            const parsed = JSON.parse(trimmed.slice(6));
            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
              callbacks.onChunk(parsed.delta.text);
            }
            if (parsed.type === "message_stop") {
              callbacks.onDone();
              return;
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    callbacks.onDone();
  }

  // ─── Prompt builders ───────────────────────────────

  private buildCompletionSystemPrompt(): string {
    return `You are an inline code completion engine for TypeScript Home Assistant automations using the TAE (TypeScript Automation Engine) framework.

You complete code at the cursor position. Return ONLY the code that should be inserted — no explanations, no markdown, no code fences.

TAE API:
- Classes extend \`Automation\` from 'tae'
- \`this.callService(domain, service, data)\` — call HA services
- \`this.getEntityState(entityId)\` — get cached entity state
- \`this.fetchEntityState(entityId)\` — fetch fresh entity state from HA
- \`this.subscribeToStateChangeEvent(entityId, callback)\` — subscribe to state changes
- \`this.subscribeToEvent(eventType, callback)\` — subscribe to HA events
- \`this.log(message)\` — log a message
- \`this.storage.persistent.get/set/delete(key, value)\` — persistent storage (SQLite)
- \`this.storage.temp.get/set/delete(key, value)\` — temporary storage (memory)
- Helper: \`sleep(ms)\`, \`startResettableTimeout(ms, callback)\`

Rules:
- Complete naturally from the cursor position
- Match the existing code style and indentation
- Prefer short, focused completions (1-5 lines)
- Do not repeat code that already exists before the cursor`;
  }

  private buildCompletionUserPrompt(req: CompletionRequest): string {
    let prompt = `File: ${req.filePath}\n`;

    if (req.otherFiles && req.otherFiles.length > 0) {
      for (const f of req.otherFiles.slice(0, 3)) {
        prompt += `\n--- ${f.path} ---\n${f.content.slice(0, 2000)}\n`;
      }
    }

    if (req.entityContext) {
      prompt += `\nAvailable entities:\n${req.entityContext.slice(0, 1000)}\n`;
    }

    prompt += `\n--- Current file (complete at <CURSOR>) ---\n${req.prefix}<CURSOR>${req.suffix}`;
    return prompt;
  }

  /**
   * Build a system prompt for the chat, including TAE context.
   */
  static buildChatSystemPrompt(
    currentFile?: { path: string; content: string },
    entitySummary?: string,
    skillMd?: string,
  ): string {
    let prompt = `You are an AI assistant integrated into TAE (TypeScript Automation Engine) for Home Assistant.
You help write, debug, and understand TypeScript automations.

TAE API summary:
- Classes extend \`Automation\` from 'tae'
- \`this.callService(domain, service, data)\` — call HA services
- \`this.getEntityState(entityId)\` — cached entity state
- \`this.fetchEntityState(entityId)\` — fresh entity state from HA
- \`this.subscribeToStateChangeEvent(entityId, callback)\` — state change events
- \`this.subscribeToEvent(eventType, callback)\` — HA events
- \`this.log(message)\` — logging
- \`this.storage.persistent.get/set/delete(key, value)\` — SQLite storage
- \`this.storage.temp.get/set/delete(key, value)\` — in-memory storage
- Helpers: \`sleep(ms)\`, \`startResettableTimeout(ms, callback)\`
- Export \`getAutomations()\` returning an array of Automation instances

When showing code, use typescript code blocks. Be concise and direct.`;

    if (skillMd) {
      prompt += `\n\nFull TAE reference:\n${skillMd.slice(0, 6000)}`;
    }

    if (currentFile) {
      prompt += `\n\nCurrently open file (${currentFile.path}):\n\`\`\`typescript\n${currentFile.content.slice(0, 8000)}\n\`\`\``;
    }

    if (entitySummary) {
      prompt += `\n\nAvailable HA entities:\n${entitySummary.slice(0, 3000)}`;
    }

    return prompt;
  }
}
