/**
 * MCP server — exposes the TAE tools to MCP clients (Claude Code, Claude
 * Desktop, other agents) over Streamable HTTP on its own port, guarded by a
 * bearer token. Stateless: every POST gets a fresh server + transport.
 */

import * as http from "http";
import * as crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Logger } from "./logging";
import { TaeTool, ToolContext, runTool } from "./tools";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const JSONRPC_INTERNAL_ERROR = -32603;
const JSONRPC_SERVER_ERROR = -32000;

const INSTRUCTIONS = `Tools for TAE (TypeScript Automation Engine), a Home Assistant add-on that runs automations written in TypeScript.
- Read get_api_reference before writing automation code. TAE loads only index.ts and calls its exported onInit().
- Use search_entities / get_entity for entity ids and attributes and list_services for service fields; never guess ids.
- Edit with read_file + edit_file (or write_file), then type_check, then reload_automations, then check list_automations and get_logs.
- call_service controls real devices: only use it when the user asks.`;

export interface McpServerOptions {
  port: number;
  getToken: () => string;
  tools: TaeTool[];
  ctx: ToolContext;
  logger: Logger;
  version: string;
}

function tokensMatch(given: string, expected: string): boolean {
  const givenBytes = Buffer.from(given);
  const expectedBytes = Buffer.from(expected);
  return givenBytes.length === expectedBytes.length && crypto.timingSafeEqual(givenBytes, expectedBytes);
}

function sendJsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function buildServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: "tae", version: options.version }, { instructions: INSTRUCTIONS });
  for (const tool of options.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.mutating,
          destructiveHint: tool.mutating ? !!tool.destructive : undefined,
          openWorldHint: false,
        },
      },
      async (args: any) => {
        if (tool.mutating) {
          options.logger.log("info", "mcp", `${tool.name} ${JSON.stringify(args).slice(0, 300)}`);
        }
        const outcome = await runTool(tool, args, options.ctx);
        return { content: [{ type: "text" as const, text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) };
      }
    );
  }
  return server;
}

export function startMcpServer(options: McpServerOptions): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url !== MCP_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const expected = options.getToken();
    const header = req.headers.authorization || "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!expected || !given || !tokensMatch(given, expected)) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="tae"' });
      res.end(JSON.stringify({ error: "Missing or invalid bearer token" }));
      return;
    }

    if (req.method !== "POST") {
      // Stateless server: no server-initiated streams and no sessions to delete
      sendJsonRpcError(res, 405, JSONRPC_SERVER_ERROR, "Method not allowed.");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err: any) {
      sendJsonRpcError(res, 400, JSONRPC_SERVER_ERROR, `Invalid request body: ${err.message}`);
      return;
    }

    const server = buildServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err: any) {
      options.logger.log("error", "mcp", `Request failed: ${err.message}`);
      sendJsonRpcError(res, 500, JSONRPC_INTERNAL_ERROR, "Internal server error");
    }
  });

  httpServer.on("error", (err: Error) => {
    options.logger.log("error", "mcp", `MCP server error: ${err.message}`);
  });
  httpServer.listen(options.port, "0.0.0.0", () => {
    options.logger.log("info", "mcp", `MCP server listening on port ${options.port} (path ${MCP_PATH})`);
  });
  return httpServer;
}
