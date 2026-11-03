/**
 * TAE tools — one definition shared by the in-app AI chat (all providers)
 * and the MCP server (Claude Code and other MCP clients).
 */

import { z } from "zod";
import { HAClient } from "../ha-client";
import { WorkerManager } from "../worker-manager";
import { FileManager } from "../file-manager";
import { Logger, LogEntry } from "../logging";
import { TypeChecker } from "./type-check";
import { unifiedDiff } from "./diff";
import { EntityCatalog, buildEntityCatalog, editDistance } from "./entity-check";
import { TestManager, testScenarioSchema } from "../test-manager";
import { ChangeSource, FileHistory } from "../file-history";
import { AutomationInfo, HAEntityState, TraceInfo } from "../../shared/messages";
import { TestResult, TestScenario } from "../../shared/tests";

const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 100;
const LOGS_DEFAULT_COUNT = 100;
const LOGS_MAX_COUNT = 1000;
const LOG_LINE_MAX_CHARS = 2000;
const READ_FILE_MAX_CHARS = 200_000;
const RESULT_JSON_MAX_CHARS = 20_000;
const STATE_SETTLE_MS = 1500; //< wait for start/stop to report back
const STATE_POLL_MS = 100;
const EDITABLE_EXTENSIONS = [".ts", ".json", ".snippets"];
const LOG_LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const TIMELINE_DEFAULT_COUNT = 10;
const TIMELINE_MAX_COUNT = 50;
const HISTORY_DEFAULT_COUNT = 20;
const TEST_TIMELINE_MAX_ITEMS = 200;
const MS_PER_SECOND = 1000;
const EDIT_HINT_EXTRA_LINES = 2; //< shown around a near miss of edit_file
const EDIT_HINT_MAX_PLACES = 3;
const EDIT_HINT_MAX_DISTANCE_RATIO = 0.3; //< a line this different (share of its length) still counts as the near miss
const EDIT_HINT_MAX_LINE_CHARS = 300; //< longer lines are only compared exactly

export interface ToolContext {
  haClient: HAClient;
  workerManager: WorkerManager;
  fileManager: FileManager;
  logger: Logger;
  typeChecker: TypeChecker;
  testManager: TestManager;
  fileHistory: FileHistory;
  /** Who is changing files, for the file history. */
  changeSource: ChangeSource;
  getSkillMarkdown: () => string;
  /** Tell open editors that a file changed on disk (content undefined = deleted). */
  notifyFileChanged: (relativePath: string, content: string | undefined) => void;
  /** Tell open UIs that the saved test scenarios changed. */
  notifyTestsChanged: () => void;
}

export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

export interface ApprovalPreview {
  summary: string;
  diff?: string;
}

export interface TaeTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<any>;
  /** Changes files, automations or devices — the in-app chat asks before running it. */
  mutating: boolean;
  destructive?: boolean;
  /** Only offered over MCP (the in-app chat already has it in its system prompt). */
  mcpOnly?: boolean;
  preview?: (input: any, ctx: ToolContext) => Promise<ApprovalPreview>;
  run: (input: any, ctx: ToolContext) => Promise<ToolOutcome>;
}

class ToolError extends Error {}

function fail(message: string): never {
  throw new ToolError(message);
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more characters)` : text;
}

function toJson(value: unknown): string {
  return truncate(JSON.stringify(value, null, 2) ?? "null", RESULT_JSON_MAX_CHARS);
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function assertEditablePath(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  if (!normalized) fail("path is empty");
  const segments = normalized.split("/");
  if (segments.includes("node_modules") || segments.some((segment) => segment.startsWith("."))) {
    fail(`${normalized} is not editable (node_modules and hidden files are managed by TAE)`);
  }
  if (!EDITABLE_EXTENSIONS.some((extension) => normalized.endsWith(extension))) {
    fail(`only ${EDITABLE_EXTENSIONS.join(", ")} files can be edited`);
  }
  return normalized;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    count++;
    position = haystack.indexOf(needle, position + needle.length);
  }
  return count;
}

function normalizeForHint(line: string): string {
  return line.trim().replace(/\s+/g, " ").replace(/[;,]+$/, "");
}

/** The file's real text where a missed old_string was most likely aimed (by its first line). */
function nearMissHint(content: string, oldString: string): string {
  const wanted = oldString.split(/\r?\n/);
  const firstWanted = wanted.find((line) => line.trim());
  if (!firstWanted) return "";
  const target = normalizeForHint(firstWanted);
  const lines = content.split(/\r?\n/);
  const scored: Array<{ iLine: number; distance: number }> = [];
  for (let iLine = 0; iLine < lines.length; iLine++) {
    const candidate = normalizeForHint(lines[iLine]);
    if (!candidate) continue;
    if (candidate === target) {
      scored.push({ iLine, distance: 0 });
    } else if (candidate.length <= EDIT_HINT_MAX_LINE_CHARS && target.length <= EDIT_HINT_MAX_LINE_CHARS) {
      const distance = editDistance(candidate, target);
      if (distance <= Math.max(candidate.length, target.length) * EDIT_HINT_MAX_DISTANCE_RATIO) scored.push({ iLine, distance });
    }
  }
  if (scored.length === 0) return " Nothing in the file looks like its first line; read_file it again.";
  scored.sort((left, right) => left.distance - right.distance || left.iLine - right.iLine);
  const places = scored.slice(0, EDIT_HINT_MAX_PLACES).map(({ iLine }) => {
    const end = Math.min(lines.length, iLine + wanted.length + EDIT_HINT_EXTRA_LINES);
    return lines.slice(iLine, end).map((line, iOffset) => `${iLine + iOffset + 1}| ${line}`).join("\n");
  });
  return ` Closest text in the file (line numbers are not part of it); copy old_string from here exactly:\n${places.join("\n---\n")}`;
}

function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean, label: string): string {
  if (!oldString) fail("old_string is empty; use write_file to create or replace a whole file");
  if (content.includes("\r\n") && !oldString.includes("\r\n") && oldString.includes("\n")) {
    oldString = oldString.replace(/\n/g, "\r\n"); //< the file uses Windows line endings
    newString = newString.replace(/\r?\n/g, "\r\n");
  }
  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 0) fail(`old_string not found in ${label}.${nearMissHint(content, oldString)}`);
  if (occurrences > 1 && !replaceAll) {
    fail(`old_string appears ${occurrences} times in ${label}; add surrounding lines to make it unique, or set replace_all`);
  }
  return replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
}

// ─── Entity search ────────────────────────────────────────────

export interface EntityRow {
  entityId: string;
  domain: string;
  name: string;
  state: string;
  unit: string;
  areaId: string;
  areaName: string;
  deviceName: string;
}

/** Known entity ids and service names, for spotting typos in code. */
export async function entityCatalog(ctx: Pick<ToolContext, "haClient">): Promise<EntityCatalog> {
  let services: string[] = [];
  try {
    const all = await ctx.haClient.getServices();
    services = Object.entries(all).flatMap(([domain, domainServices]) => Object.keys(domainServices as object).map((service) => `${domain}.${service}`));
  } catch {}
  return buildEntityCatalog(ctx.haClient.getAllStates().map((state) => state.entity_id), services);
}

export async function buildEntityRows(ctx: Pick<ToolContext, "haClient">): Promise<EntityRow[]> {
  const states = ctx.haClient.getAllStates();
  let registries = { devices: [] as any[], entities: [] as any[], areas: [] as any[] };
  try {
    registries = await ctx.haClient.getRegistries();
  } catch {
    // States alone still make search useful
  }
  const areaNames = new Map<string, string>(registries.areas.map((area: any) => [area.area_id, area.name]));
  const devices = new Map<string, any>(registries.devices.map((device: any) => [device.id, device]));
  const entityRegistry = new Map<string, any>(registries.entities.map((entry: any) => [entry.entity_id, entry]));

  return states.map((state: HAEntityState) => {
    const entry = entityRegistry.get(state.entity_id);
    const device = entry?.device_id ? devices.get(entry.device_id) : undefined;
    const areaId = entry?.area_id || device?.area_id || "";
    return {
      entityId: state.entity_id,
      domain: state.entity_id.split(".")[0],
      name: state.attributes?.friendly_name || "",
      state: state.state,
      unit: state.attributes?.unit_of_measurement || "",
      areaId,
      areaName: areaId ? areaNames.get(areaId) || areaId : "",
      deviceName: device ? device.name_by_user || device.name || "" : "",
    };
  });
}

function formatEntityRow(row: EntityRow): string {
  const parts = [row.entityId];
  if (row.name) parts.push(`"${row.name}"`);
  parts.push(`state: ${row.state}${row.unit ? " " + row.unit : ""}`);
  if (row.areaName) parts.push(`area: ${row.areaName}`);
  if (row.deviceName && row.deviceName !== row.name) parts.push(`device: ${row.deviceName}`);
  return parts.join(" — ");
}

function scoreEntity(row: EntityRow, tokens: string[]): { matched: number; score: number } {
  const id = row.entityId.toLowerCase();
  const name = row.name.toLowerCase();
  const device = row.deviceName.toLowerCase();
  const area = row.areaName.toLowerCase();
  let matched = 0;
  let score = 0;
  for (const token of tokens) {
    let tokenScore = 0;
    if (id.includes(token)) tokenScore += 3;
    if (name.includes(token)) tokenScore += 3;
    if (device.includes(token)) tokenScore += 1;
    if (area.includes(token)) tokenScore += 1;
    if (tokenScore > 0) matched++;
    score += tokenScore;
  }
  return { matched, score };
}

// ─── Logs and automations ─────────────────────────────────────

function formatLogEntry(entry: LogEntry): string {
  let line = `${entry.timestamp} ${entry.level.toUpperCase()} [${entry.source}] ${entry.message}`;
  if (entry.extra !== undefined) {
    const extra = typeof entry.extra === "string" ? entry.extra : JSON.stringify(entry.extra);
    if (extra && extra !== "{}") line += ` | ${extra}`;
  }
  return truncate(line, LOG_LINE_MAX_CHARS);
}

function formatAutomation(automation: AutomationInfo): string {
  let line = `${automation.id} (${automation.className}) — ${automation.state}`;
  if (automation.error) line += ` — error: ${automation.error}`;
  if (automation.lastError) {
    line += ` — last callback error (${automation.errorCount ?? 1}x, latest ${automation.lastErrorAt}): ${automation.lastError}`;
  }
  return line;
}

function formatAutomations(automations: AutomationInfo[]): string {
  if (automations.length === 0) return "No automations are registered (is index.ts exporting onInit()?).";
  return automations.map(formatAutomation).join("\n");
}

async function waitForAutomationState(ctx: ToolContext, automationId: string, wanted: string): Promise<AutomationInfo | undefined> {
  const deadline = Date.now() + STATE_SETTLE_MS;
  for (;;) {
    const automation = ctx.workerManager.getAutomations().find((candidate) => candidate.id === automationId);
    if (!automation || automation.state === wanted || automation.state === "error" || Date.now() > deadline) {
      return automation;
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
}

// ─── Tests, timeline and history formatting ───────────────────

function seconds(ms: number): string {
  return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}

export function formatTestResult(result: TestResult, scenario?: TestScenario): string {
  const checks = `${result.expectations.filter((item) => item.passed).length}/${result.expectations.length} checks`;
  const lines = [
    `${result.passed ? "PASSED" : "FAILED"} "${result.name}" — ${checks}, ${result.serviceCalls} service call(s)` +
      `${result.liveCalls !== undefined ? ` (${result.liveCalls} sent to Home Assistant)` : ""}, simulated ${seconds(result.simulatedMs)} (real ${result.realMs}ms)`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  const failures = result.expectations.filter((item) => !item.passed);
  if (failures.length) {
    lines.push("Failed checks:");
    for (const failure of failures) lines.push(`  step ${failure.step + 1}: ${failure.message}`);
  }
  lines.push("Timeline:");
  for (const item of result.items.slice(0, TEST_TIMELINE_MAX_ITEMS)) {
    const step = item.step !== undefined ? ` [step ${item.step + 1}]` : "";
    const who = item.automationId ? ` (${item.automationId})` : "";
    const mark = item.kind === "expect" ? (item.passed ? "✓ " : "✗ ") : "";
    const detail = item.kind === "service" && item.detail && Object.keys(item.detail).length ? " " + JSON.stringify(item.detail) : "";
    lines.push(`  +${seconds(item.at)}${step} ${item.kind}${item.level ? "/" + item.level : ""}: ${mark}${item.text}${detail}${who}`);
  }
  if (result.items.length > TEST_TIMELINE_MAX_ITEMS) lines.push(`  … ${result.items.length - TEST_TIMELINE_MAX_ITEMS} more`);
  if (scenario?.file) lines.push(`Scenario file: ${scenario.file}`);
  return lines.join("\n");
}

function describeTraceTrigger(trace: TraceInfo): string {
  const trigger = trace.trigger;
  switch (trigger.kind) {
    case "start":
      return "onStart";
    case "state":
      return `${trigger.entityId}: ${trigger.from ?? "none"} → ${trigger.to ?? "none"}`;
    case "event":
      return `event ${trigger.eventType}`;
    case "timer":
      return `${trigger.interval ? "interval" : "timer"} (${trigger.delayMs}ms, set by ${trigger.parent})`;
  }
}

function formatTrace(trace: TraceInfo): string {
  const status = trace.error ? `error: ${trace.error}` : trace.durationMs === undefined ? "running" : `${trace.durationMs}ms`;
  const lines = [`${new Date(trace.startedAt).toISOString()} ${describeTraceTrigger(trace)} — ${status}`];
  for (const action of trace.actions) {
    if (action.kind === "service") {
      const data = action.data && Object.keys(action.data).length ? " " + JSON.stringify(action.data) : "";
      lines.push(`  +${action.at}ms ${action.domain}.${action.service}${data}${action.error ? ` FAILED: ${action.error}` : ""}`);
    } else if (action.kind === "log") {
      lines.push(`  +${action.at}ms log/${action.level}: ${action.message}`);
    } else {
      lines.push(`  +${action.at}ms ERROR: ${action.message}`);
    }
  }
  if (trace.truncated) lines.push("  … more actions not recorded");
  return lines.join("\n");
}

// ─── Tool definitions ─────────────────────────────────────────

const tools: TaeTool[] = [
  {
    name: "search_entities",
    title: "Search Home Assistant entities",
    description:
      "Find Home Assistant entities by words in their entity id, friendly name, device or area. " +
      "Call this whenever you need an entity id — never guess ids. Returns id, name, state, area and device per match.",
    input: z.object({
      query: z.string().describe("Words to match, e.g. 'kitchen motion' or 'living room lamp'. Empty lists everything (use domain/area to filter)."),
      domain: z.string().optional().describe("Only this domain, e.g. 'light', 'binary_sensor'"),
      area: z.string().optional().describe("Only entities in this area (area id or name)"),
      limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`Max results (default ${SEARCH_DEFAULT_LIMIT})`),
    }),
    mutating: false,
    run: async (input, ctx) => {
      const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
      const tokens = String(input.query || "").toLowerCase().split(/[\s_.\-]+/).filter(Boolean);
      const areaFilter = (input.area || "").toLowerCase();
      let rows = await buildEntityRows(ctx);
      if (input.domain) rows = rows.filter((row) => row.domain === input.domain);
      if (areaFilter) {
        rows = rows.filter((row) => row.areaId.toLowerCase() === areaFilter || row.areaName.toLowerCase().includes(areaFilter));
      }

      let ranked = rows.map((row) => ({ row, ...scoreEntity(row, tokens) }));
      if (tokens.length > 0) {
        const allTokens = ranked.filter((item) => item.matched === tokens.length);
        ranked = allTokens.length > 0 ? allTokens : ranked.filter((item) => item.matched > 0);
      }
      ranked.sort((left, right) => right.score - left.score || left.row.entityId.localeCompare(right.row.entityId));

      if (ranked.length === 0) return { text: "No matching entities. Try fewer or different words, or drop the filters." };
      const shown = ranked.slice(0, limit).map((item) => formatEntityRow(item.row));
      const more = ranked.length > limit ? `\n… ${ranked.length - limit} more; refine the query or raise limit.` : "";
      return { text: `${ranked.length} match(es):\n${shown.join("\n")}${more}` };
    },
  },
  {
    name: "get_entity",
    title: "Get entity details",
    description:
      "Full current state of one entity: state, all attributes, device/area/integration, and the services of its domain. " +
      "Call this before writing code that reads attributes or calls services on the entity.",
    input: z.object({ entity_id: z.string().describe("Exact entity id, e.g. 'light.kitchen'") }),
    mutating: false,
    run: async (input, ctx) => {
      const state = ctx.haClient.getEntityState(input.entity_id);
      if (!state) fail(`Entity ${input.entity_id} not found. Use search_entities to find the right id.`);
      const details: Record<string, any> = { ...state };
      try {
        const registries = await ctx.haClient.getRegistries();
        const entry = registries.entities.find((candidate: any) => candidate.entity_id === input.entity_id);
        if (entry) {
          const device = entry.device_id ? registries.devices.find((candidate: any) => candidate.id === entry.device_id) : undefined;
          const areaId = entry.area_id || device?.area_id;
          const area = areaId ? registries.areas.find((candidate: any) => candidate.area_id === areaId) : undefined;
          details.registry = {
            platform: entry.platform,
            disabled_by: entry.disabled_by,
            hidden_by: entry.hidden_by,
            area: area ? { id: area.area_id, name: area.name } : undefined,
            device: device
              ? { id: device.id, name: device.name_by_user || device.name, manufacturer: device.manufacturer, model: device.model }
              : undefined,
          };
        }
      } catch {}
      try {
        const services = await ctx.haClient.getServices();
        const domainServices = services[input.entity_id.split(".")[0]];
        if (domainServices) details.domain_services = Object.keys(domainServices);
      } catch {}
      return { text: toJson(details) };
    },
  },
  {
    name: "list_areas",
    title: "List areas",
    description: "All Home Assistant areas with their ids and how many devices/entities each has.",
    input: z.object({}),
    mutating: false,
    run: async (_input, ctx) => {
      const registries = await ctx.haClient.getRegistries();
      const rows = await buildEntityRows(ctx);
      const lines = registries.areas
        .slice()
        .sort((left: any, right: any) => String(left.name).localeCompare(String(right.name)))
        .map((area: any) => {
          const deviceCount = registries.devices.filter((device: any) => device.area_id === area.area_id).length;
          const entityCount = rows.filter((row) => row.areaId === area.area_id).length;
          return `${area.area_id} — "${area.name}" — ${deviceCount} device(s), ${entityCount} entit(y/ies)`;
        });
      return { text: lines.length ? lines.join("\n") : "No areas defined." };
    },
  },
  {
    name: "list_services",
    title: "List Home Assistant services",
    description:
      "Services (actions) Home Assistant offers. Without a domain: every domain with its service names. " +
      "With a domain: each service's description and fields. Call this before using callService on an unfamiliar service.",
    input: z.object({ domain: z.string().optional().describe("e.g. 'light', 'climate', 'notify'") }),
    mutating: false,
    run: async (input, ctx) => {
      const services = await ctx.haClient.getServices();
      if (!input.domain) {
        const lines = Object.keys(services)
          .sort()
          .map((domain) => `${domain}: ${Object.keys(services[domain]).sort().join(", ")}`);
        return { text: lines.join("\n") };
      }
      const domainServices = services[input.domain];
      if (!domainServices) fail(`No services in domain ${input.domain}`);
      const lines: string[] = [];
      for (const [serviceName, service] of Object.entries<any>(domainServices)) {
        lines.push(`${input.domain}.${serviceName}${service.description ? " — " + service.description : ""}`);
        for (const [fieldName, field] of Object.entries<any>(service.fields || {})) {
          const flags = [field.required ? "required" : "", field.example !== undefined ? `e.g. ${JSON.stringify(field.example)}` : ""]
            .filter(Boolean)
            .join(", ");
          lines.push(`  ${fieldName}${flags ? ` (${flags})` : ""}${field.description ? ": " + field.description : ""}`);
        }
        if (service.target) lines.push("  target: entity_id / device_id / area_id");
      }
      return { text: truncate(lines.join("\n"), RESULT_JSON_MAX_CHARS) };
    },
  },
  {
    name: "list_files",
    title: "List automation files",
    description: "Every file in the TAE automations workspace (paths relative to the workspace root). index.ts is the entry point.",
    input: z.object({}),
    mutating: false,
    run: async (_input, ctx) => {
      const files = ctx.fileManager.listFilePaths();
      return { text: files.length ? files.join("\n") : "The workspace is empty." };
    },
  },
  {
    name: "read_file",
    title: "Read an automation file",
    description: "Read a workspace file exactly as saved on disk. Read a file before editing it.",
    input: z.object({ path: z.string().describe("Path relative to the workspace, e.g. 'index.ts' or 'lights/kitchen.ts'") }),
    mutating: false,
    run: async (input, ctx) => {
      const relativePath = normalizePath(input.path);
      if (!ctx.fileManager.exists(relativePath)) fail(`${relativePath} does not exist. Use list_files.`);
      return { text: truncate(ctx.fileManager.readFile(relativePath), READ_FILE_MAX_CHARS) };
    },
  },
  {
    name: "type_check",
    title: "Type-check automations",
    description:
      "Run the TypeScript compiler over the workspace and report errors, plus string literals that look like entity ids " +
      "Home Assistant does not know (typos). Automations run without type checking, so use this after every code change, and when debugging.",
    input: z.object({ path: z.string().optional().describe("Only report diagnostics for this file") }),
    mutating: false,
    run: async (input, ctx) => {
      const result = ctx.typeChecker.check(input.path ? normalizePath(input.path) : undefined, await entityCatalog(ctx));
      const entities = result.unknownEntityCount ? ` (${result.unknownEntityCount} unknown entity id(s))` : "";
      const summary = `${result.fileCount} file(s) checked: ${result.errorCount} error(s), ${result.warningCount} warning(s)${entities}.`;
      if (result.lines.length === 0) return { text: summary };
      return { text: `${summary}\n${result.lines.join("\n")}${result.truncated ? "\n… more diagnostics not shown" : ""}` };
    },
  },
  {
    name: "list_automations",
    title: "List automations",
    description: "Every registered automation with its state (running/stopped/error) and its latest errors.",
    input: z.object({}),
    mutating: false,
    run: async (_input, ctx) => ({ text: formatAutomations(ctx.workerManager.getAutomations()) }),
  },
  {
    name: "get_logs",
    title: "Read TAE logs",
    description:
      "Recent TAE log entries (newest last). The source is the automation id, or main/worker/ha-client for the engine. " +
      "Use it to debug automations: filter by source and/or a minimum level.",
    input: z.object({
      count: z.number().int().min(1).max(LOGS_MAX_COUNT).optional().describe(`Entries to return (default ${LOGS_DEFAULT_COUNT})`),
      level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Minimum level"),
      source: z.string().optional().describe("Only this source (automation id or engine component)"),
      contains: z.string().optional().describe("Only entries whose message contains this text (case-insensitive)"),
    }),
    mutating: false,
    run: async (input, ctx) => {
      const minimumLevel = input.level ? LOG_LEVEL_ORDER[input.level] : 0;
      const needle = (input.contains || "").toLowerCase();
      const matching = ctx.logger.getLogs(Number.MAX_SAFE_INTEGER).filter(
        (entry) =>
          (LOG_LEVEL_ORDER[entry.level] ?? 0) >= minimumLevel &&
          (!input.source || entry.source === input.source) &&
          (!needle || entry.message.toLowerCase().includes(needle))
      );
      const shown = matching.slice(-(input.count ?? LOGS_DEFAULT_COUNT));
      if (shown.length === 0) return { text: "No matching log entries." };
      return { text: `${shown.length} of ${matching.length} matching entries:\n${shown.map(formatLogEntry).join("\n")}` };
    },
  },
  {
    name: "get_automation_timeline",
    title: "Automation timeline",
    description:
      "Recent runs of one automation: what triggered each run (state change, event, timer, onStart), and the service calls, " +
      "logs and errors it caused, with timings. Use it to see why an automation did or did not act.",
    input: z.object({
      automation_id: z.string(),
      count: z.number().int().min(1).max(TIMELINE_MAX_COUNT).optional().describe(`Runs to return, newest last (default ${TIMELINE_DEFAULT_COUNT})`),
    }),
    mutating: false,
    run: async (input, ctx) => {
      const timeline = ctx.workerManager.getTimeline(input.automation_id);
      if (!timeline) {
        const known = ctx.workerManager.getAutomations().some((automation) => automation.id === input.automation_id);
        return { text: known ? `${input.automation_id} has not done anything since TAE started.` : `No automation with id ${input.automation_id}. Use list_automations.` };
      }
      const traces = timeline.traces.slice(-(input.count ?? TIMELINE_DEFAULT_COUNT));
      const ignored = timeline.ignoredCount
        ? `\n${timeline.ignoredCount} other trigger(s) did nothing (no calls, logs or errors)${timeline.lastIgnoredAt ? `, last at ${new Date(timeline.lastIgnoredAt).toISOString()}` : ""}.`
        : "";
      return { text: `${traces.length} of ${timeline.traces.length} recorded run(s):\n${traces.map(formatTrace).join("\n")}${ignored}` };
    },
  },
  {
    name: "list_tests",
    title: "List test scenarios",
    description:
      "Saved test scenarios (simulated runs of the automations) with their file and last result. Run them with run_test after changing code.",
    input: z.object({ file: z.string().optional().describe("Only scenarios of this workspace file") }),
    mutating: false,
    run: async (input, ctx) => {
      const file = input.file ? normalizePath(input.file) : "";
      const entries = ctx.testManager.list().filter((entry) => !file || entry.scenario.file === file);
      if (entries.length === 0) return { text: file ? `No test scenarios for ${file}.` : "No test scenarios yet." };
      return {
        text: entries
          .map(({ scenario, lastResult }) => {
            const result = lastResult ? `last run ${lastResult.passed ? "passed" : "FAILED"} ${lastResult.ranAt}` : "never run";
            return `${scenario.id} — "${scenario.name}" — ${scenario.file || "(no file)"} — ${scenario.steps.length} step(s) — ${result}`;
          })
          .join("\n"),
      };
    },
  },
  {
    name: "get_test",
    title: "Read a test scenario",
    description: "The full JSON of a saved test scenario (to change it with save_test).",
    input: z.object({ id: z.string() }),
    mutating: false,
    run: async (input, ctx) => {
      const entry = ctx.testManager.get(input.id);
      if (!entry) fail(`No test scenario with id ${input.id}. Use list_tests.`);
      return { text: toJson(entry.scenario) };
    },
  },
  {
    name: "run_test",
    title: "Run test scenarios",
    description:
      "Run saved test scenarios in an isolated copy of the automations: simulated states and clock (waits are instant), service calls " +
      "recorded instead of sent, so no device is touched (also for scenarios with liveCalls, which only send calls when run from the Tests tab). " +
      "Pass an id, or a file to run all of its scenarios. Returns pass/fail and a timeline.",
    input: z.object({
      id: z.string().optional().describe("Scenario id from list_tests"),
      file: z.string().optional().describe("Run every scenario of this file"),
    }),
    mutating: false,
    run: async (input, ctx) => {
      let ids: string[];
      if (input.id) {
        ids = [input.id];
      } else {
        const file = input.file ? normalizePath(input.file) : "";
        ids = ctx.testManager.list().filter((entry) => !file || entry.scenario.file === file).map((entry) => entry.scenario.id);
      }
      if (ids.length === 0) fail("No matching test scenarios. Use list_tests, or create one with save_test.");
      const outputs: string[] = [];
      let failedCount = 0;
      for (const id of ids) {
        const entry = ctx.testManager.get(id);
        if (!entry) fail(`No test scenario with id ${id}`);
        const result = await ctx.testManager.run(id, { simulateOnly: true });
        if (!result.passed) failedCount++;
        outputs.push(formatTestResult(result, entry.scenario));
      }
      const summary = ids.length > 1 ? `${ids.length - failedCount}/${ids.length} scenario(s) passed.\n\n` : "";
      return { text: summary + outputs.join("\n\n") };
    },
  },
  {
    name: "file_history",
    title: "File history",
    description:
      "Saved versions of a workspace file (every save, AI edit, import and delete), newest first. With version_id: that version's " +
      "content as a diff against the version before it. Use restore_file_version to undo a change.",
    input: z.object({
      path: z.string().optional().describe("Workspace file; omit to list recent changes across all files"),
      version_id: z.number().int().optional(),
      count: z.number().int().min(1).max(TIMELINE_MAX_COUNT * 2).optional(),
    }),
    mutating: false,
    run: async (input, ctx) => {
      if (input.version_id !== undefined) {
        const version = ctx.fileHistory.get(input.version_id);
        if (!version) fail(`No version ${input.version_id}`);
        const previous = ctx.fileHistory.previous(input.version_id);
        const header = `Version ${version.id} of ${version.path} (${version.source}, ${new Date(version.createdAt).toISOString()})`;
        if (version.deleted) return { text: `${header}: the file was deleted here.` };
        return { text: `${header}\n${unifiedDiff(previous?.content ?? "", version.content ?? "", version.path)}` };
      }
      const versions = input.path ? ctx.fileHistory.list(normalizePath(input.path)) : ctx.fileHistory.recent(input.count ?? HISTORY_DEFAULT_COUNT);
      if (versions.length === 0) return { text: "No history yet." };
      return {
        text: versions
          .slice(0, input.count ?? HISTORY_DEFAULT_COUNT)
          .map((version) => `${version.id} — ${version.path} — ${new Date(version.createdAt).toISOString()} — ${version.source}${version.deleted ? " — deleted" : ` — ${version.lines} lines`}`)
          .join("\n"),
      };
    },
  },
  {
    name: "get_api_reference",
    title: "TAE API reference",
    description: "The TAE automation API reference (SKILL.md): base class, lifecycle, every helper, patterns and rules. Read it before writing automation code.",
    input: z.object({}),
    mutating: false,
    mcpOnly: true,
    run: async (_input, ctx) => ({ text: ctx.getSkillMarkdown() || "SKILL.md is not available." }),
  },
  {
    name: "write_file",
    title: "Write an automation file",
    description:
      "Create a workspace file or replace its whole content. Prefer edit_file for changes to existing files. " +
      "Saved code takes effect after reload_automations.",
    input: z.object({
      path: z.string().describe("Path relative to the workspace, e.g. 'lights/hallway.ts'"),
      content: z.string().describe("The complete new file content"),
    }),
    mutating: true,
    preview: async (input, ctx) => {
      const relativePath = assertEditablePath(input.path);
      if (!ctx.fileManager.exists(relativePath)) {
        return { summary: `Create ${relativePath} (${input.content.split("\n").length} lines)`, diff: unifiedDiff("", input.content, relativePath) };
      }
      return { summary: `Overwrite ${relativePath}`, diff: unifiedDiff(ctx.fileManager.readFile(relativePath), input.content, relativePath) };
    },
    run: async (input, ctx) => {
      const relativePath = assertEditablePath(input.path);
      const existed = ctx.fileManager.exists(relativePath);
      ctx.fileManager.writeFile(relativePath, input.content, ctx.changeSource);
      ctx.notifyFileChanged(relativePath, input.content);
      return { text: `${existed ? "Updated" : "Created"} ${relativePath} (${input.content.split("\n").length} lines). Run reload_automations to apply.` };
    },
  },
  {
    name: "edit_file",
    title: "Edit an automation file",
    description:
      "Replace an exact piece of text in a workspace file. old_string must match the file exactly (whitespace included) " +
      "and be unique unless replace_all is set — read_file first. Saved code takes effect after reload_automations.",
    input: z.object({
      path: z.string().describe("Path relative to the workspace"),
      old_string: z.string().describe("Exact text to replace"),
      new_string: z.string().describe("Replacement text"),
      replace_all: z.boolean().optional().describe("Replace every occurrence"),
    }),
    mutating: true,
    preview: async (input, ctx) => {
      const relativePath = assertEditablePath(input.path);
      if (!ctx.fileManager.exists(relativePath)) fail(`${relativePath} does not exist`);
      const before = ctx.fileManager.readFile(relativePath);
      const after = applyEdit(before, input.old_string, input.new_string, !!input.replace_all, relativePath);
      return { summary: `Edit ${relativePath}`, diff: unifiedDiff(before, after, relativePath) };
    },
    run: async (input, ctx) => {
      const relativePath = assertEditablePath(input.path);
      if (!ctx.fileManager.exists(relativePath)) fail(`${relativePath} does not exist`);
      const before = ctx.fileManager.readFile(relativePath);
      const after = applyEdit(before, input.old_string, input.new_string, !!input.replace_all, relativePath);
      ctx.fileManager.writeFile(relativePath, after, ctx.changeSource);
      ctx.notifyFileChanged(relativePath, after);
      return { text: `Edited ${relativePath}. Run reload_automations to apply.` };
    },
  },
  {
    name: "delete_file",
    title: "Delete an automation file",
    description: "Delete one workspace file. Remove its imports from other files first.",
    input: z.object({ path: z.string().describe("Path relative to the workspace") }),
    mutating: true,
    destructive: true,
    preview: async (input, ctx) => {
      const relativePath = assertEditablePath(input.path);
      if (!ctx.fileManager.exists(relativePath)) fail(`${relativePath} does not exist`);
      const content = ctx.fileManager.readFile(relativePath);
      return { summary: `Delete ${relativePath} (${content.split("\n").length} lines)` };
    },
    run: async (input, ctx) => {
      const relativePath = assertEditablePath(input.path);
      if (!ctx.fileManager.exists(relativePath)) fail(`${relativePath} does not exist`);
      ctx.fileManager.deleteFile(relativePath, ctx.changeSource);
      ctx.notifyFileChanged(relativePath, undefined);
      return { text: `Deleted ${relativePath}.` };
    },
  },
  {
    name: "save_test",
    title: "Save a test scenario",
    description:
      "Create or update a test scenario. initial = entity states before the automations start; steps run in order: " +
      "set (entity state change), wait (seconds, instant), event (fire an HA event), expect_state, expect_service " +
      "(checks service calls since the previous expect_service; not=true expects none). Use real entity ids and automation ids.",
    input: testScenarioSchema,
    mutating: true,
    preview: async (input, ctx) => {
      const existing = input.id ? ctx.testManager.get(input.id) : undefined;
      return {
        summary: `${existing ? "Update" : "Create"} test "${input.name}"${input.file ? ` for ${input.file}` : ""}`,
        diff: unifiedDiff(existing ? JSON.stringify(existing.scenario, null, 2) : "", JSON.stringify(input, null, 2), "scenario.json"),
      };
    },
    run: async (input, ctx) => {
      const scenario = ctx.testManager.save(input);
      ctx.notifyTestsChanged();
      return { text: `Saved test "${scenario.name}" (id ${scenario.id}). Run it with run_test.` };
    },
  },
  {
    name: "restore_file_version",
    title: "Restore a file version",
    description: "Write a version from file_history back to its file (undo). The current content stays in the history.",
    input: z.object({ version_id: z.number().int() }),
    mutating: true,
    preview: async (input, ctx) => {
      const version = ctx.fileHistory.get(input.version_id);
      if (!version) fail(`No version ${input.version_id}`);
      if (version.deleted) fail(`Version ${input.version_id} marks a deletion; pick the version before it`);
      const current = ctx.fileManager.exists(version.path) ? ctx.fileManager.readFile(version.path) : "";
      return { summary: `Restore ${version.path} to version ${version.id}`, diff: unifiedDiff(current, version.content ?? "", version.path) };
    },
    run: async (input, ctx) => {
      const version = ctx.fileHistory.get(input.version_id);
      if (!version || version.deleted || version.content === null) fail(`Version ${input.version_id} cannot be restored`);
      ctx.fileManager.writeFile(version.path, version.content, "restore");
      ctx.notifyFileChanged(version.path, version.content);
      return { text: `Restored ${version.path} to version ${version.id}. Run reload_automations to apply.` };
    },
  },
  {
    name: "reload_automations",
    title: "Reload automations",
    description:
      "Restart the automation runtime so saved code takes effect: every automation is stopped and index.ts is loaded again. " +
      "Returns the automation states and any errors logged while loading.",
    input: z.object({}),
    mutating: true,
    preview: async () => ({ summary: "Reload all automations (each one restarts)" }),
    run: async (_input, ctx) => {
      const startedAt = new Date().toISOString();
      let failure = "";
      try {
        await ctx.workerManager.reload();
      } catch (err: any) {
        failure = `Reload failed: ${err.message}\n`;
      }
      const problems = ctx.logger
        .getLogs(Number.MAX_SAFE_INTEGER)
        .filter((entry) => entry.timestamp >= startedAt && (entry.level === "error" || entry.level === "warn"));
      const problemText = problems.length ? `\nWarnings/errors while loading:\n${problems.map(formatLogEntry).join("\n")}` : "";
      return { text: `${failure}${formatAutomations(ctx.workerManager.getAutomations())}${problemText}`, isError: !!failure };
    },
  },
  {
    name: "set_automation_state",
    title: "Start or stop an automation",
    description: "Start or stop one registered automation (by id from list_automations). Stopping lasts until it is started again or automations reload.",
    input: z.object({
      automation_id: z.string(),
      action: z.enum(["start", "stop"]),
    }),
    mutating: true,
    preview: async (input) => ({ summary: `${input.action === "start" ? "Start" : "Stop"} automation ${input.automation_id}` }),
    run: async (input, ctx) => {
      const known = ctx.workerManager.getAutomations().some((automation) => automation.id === input.automation_id);
      if (!known) fail(`No automation with id ${input.automation_id}. Use list_automations.`);
      if (input.action === "start") await ctx.workerManager.startAutomation(input.automation_id);
      else await ctx.workerManager.stopAutomation(input.automation_id);
      const automation = await waitForAutomationState(ctx, input.automation_id, input.action === "start" ? "running" : "stopped");
      return { text: automation ? formatAutomation(automation) : `${input.automation_id} is no longer registered.` };
    },
  },
  {
    name: "call_service",
    title: "Call a Home Assistant service",
    description:
      "Call a Home Assistant service right now (controls real devices). Only use it when the user asks you to control " +
      "or test something. Check fields with list_services first.",
    input: z.object({
      domain: z.string().describe("e.g. 'light'"),
      service: z.string().describe("e.g. 'turn_on'"),
      data: z.record(z.string(), z.any()).optional().describe("Service data, e.g. { brightness_pct: 50 }"),
      target: z
        .object({
          entity_id: z.union([z.string(), z.array(z.string())]).optional(),
          device_id: z.union([z.string(), z.array(z.string())]).optional(),
          area_id: z.union([z.string(), z.array(z.string())]).optional(),
        })
        .optional()
        .describe("Which entities/devices/areas to act on"),
    }),
    mutating: true,
    preview: async (input) => ({
      summary: `Call ${input.domain}.${input.service}`,
      diff: JSON.stringify({ target: input.target, data: input.data }, null, 2),
    }),
    run: async (input, ctx) => {
      const result = await ctx.haClient.callService(input.domain, input.service, input.data, input.target);
      ctx.logger.log("info", "ai-tools", `Called ${input.domain}.${input.service}`, { target: input.target, data: input.data });
      return { text: `Called ${input.domain}.${input.service}.${result ? "\n" + toJson(result) : ""}` };
    },
  },
];

export function getTools(): TaeTool[] {
  return tools;
}

export function getChatTools(): TaeTool[] {
  return tools.filter((tool) => !tool.mcpOnly);
}

export function findTool(name: string): TaeTool | undefined {
  return tools.find((tool) => tool.name === name);
}

/** JSON schema for provider tool definitions (no $schema key). */
export function toolJsonSchema(tool: TaeTool): Record<string, any> {
  const schema: Record<string, any> = z.toJSONSchema(tool.input, { io: "input" }) as any;
  delete schema.$schema;
  return schema;
}

/** Run a tool, turning thrown errors into an error outcome. */
export async function runTool(tool: TaeTool, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    return { text: `Invalid input for ${tool.name}: ${parsed.error.message}`, isError: true };
  }
  try {
    return await tool.run(parsed.data, ctx);
  } catch (err: any) {
    return { text: err instanceof ToolError ? err.message : `${tool.name} failed: ${err?.message ?? err}`, isError: true };
  }
}

/** Build the approval preview, or the error that would stop the tool. */
export async function previewTool(tool: TaeTool, input: unknown, ctx: ToolContext): Promise<ApprovalPreview | ToolOutcome> {
  if (!tool.preview) return { summary: tool.title };
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    return { text: `Invalid input for ${tool.name}: ${parsed.error.message}`, isError: true };
  }
  try {
    return await tool.preview(parsed.data, ctx);
  } catch (err: any) {
    return { text: err instanceof ToolError ? err.message : `${tool.name} failed: ${err?.message ?? err}`, isError: true };
  }
}
