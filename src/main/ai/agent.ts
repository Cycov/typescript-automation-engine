/**
 * Chat agent — runs the tool loop for the in-app AI chat with any provider.
 * Mutating tools wait for the user's approval in the UI.
 */

import { Logger } from "../logging";
import { ToolContext, getChatTools, findTool, previewTool, runTool, toolJsonSchema } from "../tools";
import { AISettings } from "./config";
import { createChatProvider, createCompletionProvider } from "./providers";
import { turnCostUsd } from "./pricing";
import {
  CompletionRequest,
  EditorContext,
  ResolvedMentions,
  buildChatSystemPrompt,
  buildCompletionSystemPrompt,
  buildCompletionUserPrompt,
  buildUserTurn,
  cleanCompletion,
} from "./prompts";
import { EffortLevel, ProviderError, StopReason, ToolResultItem, ToolSpec, TurnResult, TurnUsage, addUsage, emptyUsage } from "./types";

const MAX_TOOL_ROUNDS = 30;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 20; //< kept in memory; all chats are also saved
const SAVED_CHAT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SAVED_CHAT_MAX_COUNT = 50;
const TOOL_OUTPUT_UI_MAX_CHARS = 6000;
const INVALID_JSON_KEY = "INVALID_JSON";
const MAX_MENTIONS = 10;

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "thinking" }
  | { type: "tool_start"; id: string; name: string; title: string; input: unknown }
  | { type: "approval_request"; id: string; name: string; title: string; summary: string; diff?: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; output: string; declined?: boolean }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; usage: TurnUsage; stopReason: StopReason | "cancelled" | "error"; costUsd?: number };

export type ApprovalDecision = "allow" | "deny" | "always";

/** Where chats are saved, so they survive a restart of TAE. */
export interface ChatSessionStore {
  getChatSession(id: string): any | undefined;
  saveChatSession(id: string, data: any): void;
  deleteChatSession(id: string): void;
  pruneChatSessions(maxAgeMs: number, keepCount: number): void;
}

export interface ChatSendOptions {
  /** Messages the UI shows before this one; when the server has none of them, the user is told. */
  priorMessages?: number;
}

interface ChatSession {
  id: string;
  providerKey: string;
  effort: EffortLevel; //< fixed per chat: changing it would invalidate the prompt cache
  system: string;
  history: unknown[];
  lastUsed: number;
  running: AbortController | null;
  approvals: Map<string, (decision: ApprovalDecision) => void>;
  alwaysAllow: Set<string>;
}

let cachedToolSpecs: ToolSpec[] | null = null;

function chatToolSpecs(): ToolSpec[] {
  if (!cachedToolSpecs) {
    cachedToolSpecs = getChatTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolJsonSchema(tool),
    }));
  }
  return cachedToolSpecs;
}

function clipForUi(text: string): string {
  return text.length > TOOL_OUTPUT_UI_MAX_CHARS ? `${text.slice(0, TOOL_OUTPUT_UI_MAX_CHARS)}\n…` : text;
}

export class ChatAgent {
  private settings: AISettings;
  private ctx: ToolContext;
  private logger: Logger;
  private sessions = new Map<string, ChatSession>();
  private store: ChatSessionStore;

  constructor(settings: AISettings, ctx: ToolContext, logger: Logger, store: ChatSessionStore) {
    this.settings = settings;
    this.ctx = ctx;
    this.logger = logger;
    this.store = store;
    try {
      store.pruneChatSessions(SAVED_CHAT_MAX_AGE_MS, SAVED_CHAT_MAX_COUNT);
    } catch (err: any) {
      logger.log("warn", "ai", `Could not prune saved chats: ${err?.message ?? err}`);
    }
  }

  /** Handle one user message: run model turns and tools until the model is done. */
  async send(sessionId: string, text: string, context: EditorContext | undefined, emit: (event: ChatEvent) => void, options: ChatSendOptions = {}): Promise<void> {
    const config = this.settings.get();
    if (!this.settings.isConfigured(config)) {
      emit({ type: "error", message: "AI is not configured. Open AI settings (⚙) and set a provider, API key and model." });
      emit({ type: "done", usage: emptyUsage(), stopReason: "error" });
      return;
    }

    const provider = createChatProvider(config, this.settings.chatModel(config));
    let session = this.sessions.get(sessionId) ?? this.loadSession(sessionId);
    if (session && session.providerKey !== provider.key) {
      if (session.running) session.running.abort();
      if (session.history.length > 0) {
        emit({ type: "notice", message: "The AI model changed, so this message starts a fresh conversation." });
      }
      session = undefined;
    }
    if (!session) {
      session = this.createSession(sessionId, provider.key, config.chatEffort);
      if ((options.priorMessages ?? 0) > 0) {
        emit({
          type: "notice",
          message: "TAE no longer has the earlier messages of this chat, so the AI only sees this message. Repeat what matters, or start a new chat.",
        });
      }
    }
    if (session.running) {
      emit({ type: "error", message: "Still working on the previous message — wait or press Stop." });
      emit({ type: "done", usage: emptyUsage(), stopReason: "error" });
      return;
    }

    const controller = new AbortController();
    session.running = controller;
    session.lastUsed = Date.now();
    const usage = emptyUsage();
    const model = this.settings.chatModel(config);
    let costUsd: number | undefined = config.provider === "anthropic" ? 0 : undefined;
    let stopReason: StopReason | "cancelled" | "error" = "end_turn";

    provider.pushUser(session.history, buildUserTurn(text, context, this.resolveMentions(context?.mentions)));
    try {
      for (let iRound = 0; ; iRound++) {
        if (iRound >= MAX_TOOL_ROUNDS) {
          emit({ type: "notice", message: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds. Send a message to continue.` });
          stopReason = "other";
          break;
        }
        const turn = await provider.runTurn(
          session.history,
          session.system,
          chatToolSpecs(),
          session.effort,
          { onText: (delta) => emit({ type: "text", delta }), onThinking: () => emit({ type: "thinking" }) },
          controller.signal
        );
        addUsage(usage, turn.usage);
        if (costUsd !== undefined) {
          const turnCost = turnCostUsd(model, turn.usage);
          costUsd = turnCost === undefined ? undefined : costUsd + turnCost;
        }
        stopReason = turn.stopReason;
        if (turn.toolCalls.length === 0) {
          if (turn.stopReason === "refusal") emit({ type: "notice", message: "The model declined to answer this request." });
          if (turn.stopReason === "max_tokens") emit({ type: "notice", message: "The reply hit the output limit and was cut off." });
          break;
        }

        const results = await this.runToolCalls(session, turn, controller.signal, emit);
        provider.pushToolResults(session.history, results);
        if (controller.signal.aborted) {
          stopReason = "cancelled";
          break;
        }
        if (turn.stopReason === "refusal") {
          emit({ type: "notice", message: "The model declined to continue." });
          break;
        }
      }
    } catch (err: any) {
      if (controller.signal.aborted) {
        stopReason = "cancelled";
      } else {
        stopReason = "error";
        const message = err instanceof ProviderError ? err.message : `AI request failed: ${err?.message ?? err}`;
        this.logger.log("error", "ai", message);
        emit({ type: "error", message });
      }
    } finally {
      session.running = null;
      session.lastUsed = Date.now();
      this.saveSession(session);
      emit({ type: "done", usage, stopReason, ...(costUsd !== undefined ? { costUsd } : {}) });
    }
  }

  private loadSession(sessionId: string): ChatSession | undefined {
    let saved: any;
    try {
      saved = this.store.getChatSession(sessionId);
    } catch (err: any) {
      this.logger.log("warn", "ai", `Could not load saved chat: ${err?.message ?? err}`);
    }
    if (!saved || !Array.isArray(saved.history)) return undefined;
    const session = this.createSession(sessionId, String(saved.providerKey || ""), saved.effort ?? "");
    session.history = saved.history;
    session.alwaysAllow = new Set(Array.isArray(saved.alwaysAllow) ? saved.alwaysAllow : []);
    return session;
  }

  private saveSession(session: ChatSession): void {
    if (session.history.length === 0) return;
    try {
      this.store.saveChatSession(session.id, {
        providerKey: session.providerKey,
        effort: session.effort,
        history: session.history,
        alwaysAllow: [...session.alwaysAllow],
      });
    } catch (err: any) {
      this.logger.log("warn", "ai", `Could not save the chat: ${err?.message ?? err}`);
    }
  }

  /** Files and entities the user wrote as @name; unknown names are left as plain text. */
  private resolveMentions(mentions: string[] | undefined): ResolvedMentions | undefined {
    if (!mentions || mentions.length === 0) return undefined;
    const resolved: ResolvedMentions = { files: [], entities: [] };
    for (const name of [...new Set(mentions)].slice(0, MAX_MENTIONS)) {
      const state = this.ctx.haClient.getEntityState(name);
      if (state) {
        resolved.entities.push({ entityId: name, state });
        continue;
      }
      try {
        if (this.ctx.fileManager.exists(name)) resolved.files.push({ path: name, content: this.ctx.fileManager.readFile(name) });
      } catch {}
    }
    return resolved;
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.running?.abort();
  }

  reset(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.running?.abort();
    this.sessions.delete(sessionId);
    try {
      this.store.deleteChatSession(sessionId);
    } catch {}
  }

  decide(sessionId: string, toolUseId: string, decision: ApprovalDecision): void {
    this.sessions.get(sessionId)?.approvals.get(toolUseId)?.(decision);
  }

  /** Inline completion for the editor. Returns "" when AI is off or the request was superseded. */
  async complete(req: CompletionRequest, signal: AbortSignal): Promise<string> {
    const config = this.settings.get();
    if (!this.settings.isConfigured(config)) return "";
    const provider = createCompletionProvider(config, this.settings.completionModel(config));
    const text = await provider.complete(buildCompletionSystemPrompt(), buildCompletionUserPrompt(req), config.completionEffort, signal);
    return cleanCompletion(text);
  }

  private createSession(sessionId: string, providerKey: string, effort: EffortLevel): ChatSession {
    this.pruneSessions();
    const session: ChatSession = {
      id: sessionId,
      providerKey,
      effort,
      system: buildChatSystemPrompt(this.ctx.getSkillMarkdown()),
      history: [],
      lastUsed: Date.now(),
      running: null,
      approvals: new Map(),
      alwaysAllow: new Set(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.running && now - session.lastUsed > SESSION_IDLE_MS) this.sessions.delete(id);
    }
    const idle = [...this.sessions.values()].filter((session) => !session.running).sort((left, right) => left.lastUsed - right.lastUsed);
    while (this.sessions.size >= MAX_SESSIONS && idle.length > 0) {
      this.sessions.delete(idle.shift()!.id);
    }
  }

  private async runToolCalls(
    session: ChatSession,
    turn: TurnResult,
    signal: AbortSignal,
    emit: (event: ChatEvent) => void
  ): Promise<ToolResultItem[]> {
    const results: ToolResultItem[] = [];
    const finish = (id: string, name: string, text: string, isError: boolean, declined = false) => {
      results.push({ id, text, isError });
      emit({ type: "tool_end", id, name, ok: !isError && !declined, output: clipForUi(text), ...(declined ? { declined } : {}) });
    };

    for (const call of turn.toolCalls) {
      if (signal.aborted) {
        results.push({ id: call.id, text: "Cancelled by the user.", isError: true });
        continue;
      }
      const tool = findTool(call.name);
      emit({ type: "tool_start", id: call.id, name: call.name, title: tool?.title ?? call.name, input: call.input });

      if (!tool || tool.mcpOnly) {
        finish(call.id, call.name, `Unknown tool ${call.name}.`, true);
        continue;
      }
      if (call.inputError !== undefined) {
        finish(call.id, call.name, JSON.stringify({ [INVALID_JSON_KEY]: call.inputError }), true);
        continue;
      }
      if (turn.stopReason === "max_tokens") {
        finish(call.id, call.name, "The tool input was cut off by the output limit, so it was not run. Make the change in smaller steps.", true);
        continue;
      }
      if (turn.stopReason === "refusal") {
        finish(call.id, call.name, "Not run.", true);
        continue;
      }
      const parsed = tool.input.safeParse(call.input);
      if (!parsed.success) {
        finish(call.id, call.name, JSON.stringify({ [INVALID_JSON_KEY]: JSON.stringify(call.input ?? null) }), true);
        continue;
      }

      if (tool.mutating && !session.alwaysAllow.has(tool.name)) {
        const preview = await previewTool(tool, parsed.data, this.ctx);
        if ("text" in preview) {
          finish(call.id, call.name, preview.text, true);
          continue;
        }
        emit({ type: "approval_request", id: call.id, name: tool.name, title: tool.title, summary: preview.summary, diff: preview.diff });
        const decision = await this.waitForDecision(session, call.id, signal);
        if (signal.aborted) {
          finish(call.id, call.name, "Cancelled by the user.", true);
          continue;
        }
        if (decision === "deny") {
          this.logger.log("info", "ai", `Declined: ${preview.summary}`);
          finish(call.id, call.name, "The user declined this action.", false, true);
          continue;
        }
        if (decision === "always") session.alwaysAllow.add(tool.name);
        this.logger.log("info", "ai", `Approved: ${preview.summary}`);
      }

      const outcome = await runTool(tool, parsed.data, this.ctx);
      finish(call.id, call.name, outcome.text, !!outcome.isError);
    }
    return results;
  }

  private waitForDecision(session: ChatSession, toolUseId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const onAbort = () => {
        session.approvals.delete(toolUseId);
        resolve("deny");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      session.approvals.set(toolUseId, (decision) => {
        signal.removeEventListener("abort", onAbort);
        session.approvals.delete(toolUseId);
        resolve(decision);
      });
    });
  }
}
