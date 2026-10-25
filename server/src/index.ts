import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TabRegistry } from "./registry.js";
import { Denylist } from "./denylist.js";
import { buildServer } from "./tools.js";
import { portalMiddleware } from "./portal.js";

// ---------- configuration ----------
const PORT = parseInt(process.env.PORT ?? "8080", 10);
const MCP_TOKEN = process.env.MCP_TOKEN ?? "";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN ?? "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "*")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const CALL_TIMEOUT_MS = parseInt(process.env.CALL_TIMEOUT_MS ?? "20000", 10);
const DENYLIST_EXTRA = process.env.DENYLIST ?? "";

if (!MCP_TOKEN || MCP_TOKEN.length < 32) {
  console.error("MCP_TOKEN must be set to at least 32 random bytes (e.g. `openssl rand -base64 32`)");
  process.exit(1);
}
if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 16) {
  console.error("BRIDGE_TOKEN must be set to at least 16 characters");
  process.exit(1);
}

function log(ev: string, fields: Record<string, unknown> = {}) {
  // Structured log. Never log params, results or image bytes.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ev, ...fields }));
}

// ---------- constant-time token compare ----------
function tokensMatch(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- rate limiting: 10 tool calls per second per token ----------
const buckets = new Map<string, { tokens: number; last: number }>();
function rateLimit(key: string, perSecond = 10, burst = 10): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: burst, last: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * perSecond);
  b.last = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

// ---------- registry ----------
const registry = new TabRegistry(5, CALL_TIMEOUT_MS);
const denylist = new Denylist(DENYLIST_EXTRA);

// ---------- HTTP app ----------
const app = express();
// put_file carries base64 payloads (capped at PUT_FILE_MAX in tools); 12 MB
// leaves headroom over the tool's own limit.
app.use(express.json({ limit: "12mb" }));

app.get("/healthz", (_req, res) => {
  res.type("text/plain").send("ok");
});

// MCP endpoint: bearer auth (Authorization: Bearer <token> or X-Relay-Token)
function mcpAuth(req: express.Request): boolean {
  const header = req.get("authorization");
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : req.get("x-relay-token") ?? "";
  return supplied.length > 0 && tokensMatch(supplied, MCP_TOKEN);
}

async function handleMcp(req: express.Request, res: express.Response) {
  if (!mcpAuth(req)) {
    log("auth_rejected", { path: "/mcp" });
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized: missing or wrong bearer token" }, id: null });
    return;
  }
  if (!rateLimit(`mcp:${MCP_TOKEN.length}`)) {
    res.status(429).json({ jsonrpc: "2.0", error: { code: -32002, message: "rate limit: 10 calls/second" }, id: null });
    return;
  }
  // Stateless Streamable HTTP: a fresh server+transport per request.
  const server = buildServer(registry, denylist, log);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log("mcp_error", { err: String((e as Error).message ?? e).slice(0, 200) });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  }
}

app.post("/mcp", handleMcp);
app.get("/mcp", handleMcp);    // stateless: SSE stream GET is not supported; SDK answers 400
app.delete("/mcp", handleMcp); // stateless: SDK answers 405

// ---------- combined portal: serve the WASM apps, bridge scripts and the
// ---------- portal index from this same origin, behind the MCP routes.
// Only mounted when a fetched site directory exists (PORTAL_DIR, default
// "site" relative to the working directory), so the relay stays runnable
// standalone (Docker path, local dev).
const PORTAL_DIR = path.resolve(process.cwd(), process.env.PORTAL_DIR ?? "site");
if (fs.existsSync(path.join(PORTAL_DIR, "bridge", "loader.js"))) {
  log("portal_mounted", { dir: PORTAL_DIR });
  const portal = portalMiddleware(PORTAL_DIR);
  app.use((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "portal serves GET/HEAD only" });
      return;
    }
    portal(req, res);
  });
} else {
  log("portal_absent", { dir: PORTAL_DIR });
}

// ---------- HTTP server + bridge WebSocket ----------
const httpServer = app.listen(PORT, () => {
  log("relay_up", { port: PORT, origins: ALLOWED_ORIGINS.length || 0, timeoutMs: CALL_TIMEOUT_MS });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/bridge") {
    socket.destroy();
    return;
  }
  // Origin allowlist: a rogue page must not open a bridge socket.
  const origin = (req.headers.origin ?? "").toLowerCase();
  const allowAll = ALLOWED_ORIGINS.includes("*");
  const originOk = allowAll || (origin !== "" && ALLOWED_ORIGINS.includes(origin));
  const token = url.searchParams.get("token") ?? "";
  if (!originOk || !token || !tokensMatch(token, BRIDGE_TOKEN)) {
    log("bridge_rejected", { origin: origin.slice(0, 120) });
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.once("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { ws.close(1003, "bad json"); return; }
      if (msg?.type !== "hello" || typeof msg.app !== "string") {
        ws.close(1003, "expected hello first");
        return;
      }
      let sessionId: string;
      try {
        sessionId = registry.register(ws, String(msg.app), String(msg.version ?? "?"), String(msg.tabId ?? "?"));
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: String((e as Error).message ?? e) }));
        ws.close(1013, "too many tabs");
        return;
      }
      log("tab_connected", { session: sessionId, app: msg.app, version: msg.version, tab: msg.tabId });
      ws.send(JSON.stringify({ type: "welcome", sessionId }));

      ws.on("message", (raw) => {
        let m: any;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m?.type === "response" && typeof m.id === "string") {
          const ms = registry.handleResponse(m.id, m.ok !== false, m.result ?? m.error);
          registry.touchSeen(sessionId);
          if (ms !== null) log("call_done", { session: sessionId, ms });
        } else if (m?.type === "activity") {
          registry.touchSeen(sessionId);
        }
      });
      ws.on("pong", () => registry.markAlive(sessionId));
      ws.on("close", () => {
        registry.drop(sessionId);
        log("tab_disconnected", { session: sessionId });
      });
    });
  });
});

// Heartbeat: ping every 15 s; two missed rounds (30 s) drop a dead tab so
// hidden tabs keep their socket alive while truly dead ones are reaped.
setInterval(() => {
  for (const dropped of registry.sweepDeadTabs()) log("tab_dead", { session: dropped });
}, 15_000);

process.on("SIGTERM", () => {
  log("relay_sigterm");
  httpServer.close(() => process.exit(0));
});
