/**
 * Prompts for the chat agent and inline completions.
 * The chat system prompt is fixed for a whole session (prompt caching and
 * thinking-block replay need an unchanged prefix); per-message editor state
 * travels inside the user message instead.
 */

const CONTEXT_FILE_MAX_CHARS = 60_000;
const CONTEXT_SELECTION_MAX_CHARS = 8_000;
const MENTIONED_FILE_MAX_CHARS = 40_000;
const MENTIONED_ENTITY_MAX_CHARS = 3_000;
const COMPLETION_OTHER_FILES = 3;
const COMPLETION_OTHER_FILE_MAX_CHARS = 2000;
const COMPLETION_ENTITY_MAX_CHARS = 1000;

export interface EditorContext {
  activeFile?: string;
  modified?: boolean;
  /** Editor content; sent only when it has unsaved changes. */
  content?: string;
  selection?: string;
  localTime?: string;
  /** Words the user wrote as @name: workspace files or entity ids. */
  mentions?: string[];
}

/** @mentions resolved on the server. */
export interface ResolvedMentions {
  files: Array<{ path: string; content: string }>;
  entities: Array<{ entityId: string; state: unknown }>;
}

export interface CompletionRequest {
  prefix: string;
  suffix: string;
  filePath: string;
  otherFiles?: Array<{ path: string; content: string }>;
  entityContext?: string;
}

export function buildChatSystemPrompt(skillMarkdown: string): string {
  return `You are the assistant built into TAE (TypeScript Automation Engine), a Home Assistant add-on that runs home automations written in TypeScript. You help the user write, debug and fix their automations and answer questions about their Home Assistant setup.

# Workspace
- Automation files live in the TAE workspace. Paths are relative to it, e.g. "index.ts" or "lights/kitchen.ts".
- TAE loads only index.ts and calls its exported onInit(). Other files are ordinary modules that index.ts imports.
- Code runs without type checking (transpile only), so type errors do not stop it from loading. Use type_check to find them.
- Saved files take effect only after reload_automations (or the user pressing Reload). A reload restarts every automation.

# How to work
- Look things up instead of guessing: search_entities and get_entity for entity ids, states and attributes; list_services for service names and fields; list_files and read_file for code; list_automations and get_logs when debugging.
- If a request refers to something you cannot find in this conversation ("fix it", "the two problems"), ask what is meant before changing anything; never guess and edit.
- Read a file before changing it. Prefer edit_file with a small, unique old_string; use write_file for new files or full rewrites. Keep the user's code style and structure, and change only what the task needs.
- The user approves each change (file edits, reloads, starting/stopping automations, service calls) in the UI. If they decline, ask what they would like instead of retrying.
- After changing code, run type_check. Then offer to reload; after a reload, check list_automations and get_logs for errors.
- Only use call_service when the user asks you to control or test a device.
- To see what an automation actually did (triggers, service calls, errors, timings), use get_automation_timeline.
- Test scenarios replay state changes against a simulated copy of the automations (no device is touched; waits are instant). After changing an automation, run its scenarios with run_test (list_tests shows them). When you fix a bug or add behaviour, offer to add a scenario with save_test.
- Every file change is versioned: file_history and restore_file_version undo changes.
- A user message may start with an <editor_context> block describing the editor (open file, unsaved content, selection, local time, and files or entities the user mentioned with @). It is background, not a request.

# Style
- Be brief and concrete. Show code in \`\`\`typescript blocks only when it helps; make changes with the tools instead of pasting whole files.

# TAE API reference
${skillMarkdown || "(SKILL.md not available — read the code and tae type definitions instead.)"}`;
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more characters)` : text;
}

/** User message with the editor state in front of the user's text. */
export function buildUserTurn(text: string, context?: EditorContext, mentions?: ResolvedMentions): string {
  if (!context) return text;
  const lines: string[] = [];
  if (context.localTime) lines.push(`Local time: ${context.localTime}`);
  if (context.activeFile) {
    lines.push(`Open file: ${context.activeFile}${context.modified ? " (unsaved changes — editor content below; read_file returns the saved version)" : ""}`);
    if (context.modified && context.content !== undefined) {
      lines.push("```typescript", clip(context.content, CONTEXT_FILE_MAX_CHARS), "```");
    }
  } else {
    lines.push("Open file: none");
  }
  if (context.selection) {
    lines.push("Selected text:", "```", clip(context.selection, CONTEXT_SELECTION_MAX_CHARS), "```");
  }
  for (const file of mentions?.files || []) {
    lines.push(`Mentioned file ${file.path} (saved version):`, "```typescript", clip(file.content, MENTIONED_FILE_MAX_CHARS), "```");
  }
  for (const entity of mentions?.entities || []) {
    lines.push(`Mentioned entity ${entity.entityId}:`, "```json", clip(JSON.stringify(entity.state, null, 2), MENTIONED_ENTITY_MAX_CHARS), "```");
  }
  return `<editor_context>\n${lines.join("\n")}\n</editor_context>\n\n${text}`;
}

export function buildCompletionSystemPrompt(): string {
  return `You are an inline code completion engine for TypeScript Home Assistant automations written for TAE (TypeScript Automation Engine).

Return ONLY the code to insert at <CURSOR> — no explanations, no markdown, no code fences.

TAE API (import from 'tae'):
- Classes extend \`Automation\`; lifecycle: onStart(), onStop(), onReload(), onUnload()
- \`this.callService(domain, service, data)\` — call a Home Assistant service
- \`this.subscribeToStateChangeEvent(entityId, callback, emitAll?)\` — entity state changes
- \`this.subscribeToEvent(eventType, callback)\` / \`this.onStateChange(callback)\`
- \`await this.getEntityState(entityId)\` (local copy) / \`await this.fetchEntityState(entityId)\` (live)
- Standalone \`getEntityState(entityId)\` is synchronous
- \`this.log/warn/error/debug(message, extra?)\`, \`await this.sleep(ms)\`
- \`this.storage.persistent\` / \`this.storage.temp\`: get(key), set(key, value), delete(key)

Rules:
- Continue naturally from the cursor; match the surrounding style and indentation
- Prefer short completions (1-5 lines); never repeat code that is already before the cursor
- Use helpers from the user's other files when they fit`;
}

export function buildCompletionUserPrompt(req: CompletionRequest): string {
  let prompt = `File: ${req.filePath}\n`;
  for (const file of (req.otherFiles || []).slice(0, COMPLETION_OTHER_FILES)) {
    prompt += `\n--- ${file.path} ---\n${file.content.slice(0, COMPLETION_OTHER_FILE_MAX_CHARS)}\n`;
  }
  if (req.entityContext) {
    prompt += `\nSome entity ids: ${req.entityContext.slice(0, COMPLETION_ENTITY_MAX_CHARS)}\n`;
  }
  prompt += `\n--- Current file (complete at <CURSOR>) ---\n${req.prefix}<CURSOR>${req.suffix}`;
  return prompt;
}

/** Strip code fences a model may add despite instructions. */
export function cleanCompletion(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z]*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}
