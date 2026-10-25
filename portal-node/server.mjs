/* Craft Suite portal — Node variant (Pxxl-free build path).
 *
 * Serves the fetched WASM apps with the same behavior nginx gives them in the
 * Docker build (correct MIME, cache rules, COOP/COEP/CORP, precompressed .gz)
 * and reverse-proxies /relay/ — HTTP and WebSocket — to the craft-relay
 * service, so the in-page bridge keeps talking same-origin.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const httpProxy = require("http-proxy");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, "site");
const RELAY_TARGET = process.env.RELAY_URL || ""; // e.g. https://craft-relay-xxxx.pxxlspace.cv

const MIME = {
  wasm: "application/wasm",
  js: "text/javascript",
  mjs: "text/javascript",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  svg: "image/svg+xml",
  svgz: "image/svg+xml",
  webmanifest: "application/manifest+json",
  json: "application/json",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain",
  "wasm.orig": "application/octet-stream",
};

// Hashed, immutable assets live in these apps; hashed names mean versioned
// URLs are safe to cache forever (same rule as nginx's wasm|js location).
const IMMUTABLE_APPS = new Set([
  "photocraft", "pdfcraft", "vectorcraft", "filmcraft",
  "designcraft", "figcraft", "soundcraft", "cadcraft",
]);

const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

function applyHeaders(res, extra) {
  const h = { ...SECURITY_HEADERS, ...(extra || {}) };
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function send404(res) {
  applyHeaders(res, { "Content-Type": "text/html" });
  res.statusCode = 404;
  res.end("404\n");
}

/* Segments from the raw, decoded URL (never from path.normalize, which flips
 * slashes on win32 and would break first-segment cache lookups). */
function parsePath(urlString) {
  const raw = decodeURIComponent((urlString || "/").split("?")[0]);
  const segments = raw.split("/").filter((s) => s.length > 0 && s !== ".." && s !== ".").map((s) => s);
  return segments;
}

function serveFile(res, absFile, firstSegment, wantsGzip, status = 200) {
  const ext = path.extname(absFile).slice(1).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  const immutable = IMMUTABLE_APPS.has(firstSegment) && /\.(wasm|js)$/.test(absFile);
  headers["Cache-Control"] = immutable ? "public, max-age=31536000, immutable" : "no-cache";

  let readPath = absFile;
  if (wantsGzip && fs.existsSync(absFile + ".gz")) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    readPath = absFile + ".gz";
  }
  const stat = fs.statSync(readPath);
  headers["Content-Length"] = stat.size;
  applyHeaders(res, headers);
  res.statusCode = status;
  if (reqMethod(res) === "HEAD") {
    // Content-Length is already set; no body for HEAD.
    res.end();
    return;
  }
  fs.createReadStream(readPath).pipe(res);
}

function reqMethod(res) {
  const r = res.req || res.socket?._req;
  return r ? r.method : "GET";
}

function serveSite(req, res) {
  const segments = parsePath(req.url);
  const wantsGzip = (req.headers["accept-encoding"] || "").includes("gzip");

  if (segments.length === 1 && segments[0] === "healthz") {
    applyHeaders(res, { "Content-Type": "text/plain" });
    res.statusCode = 200;
    res.end("ok\n");
    return;
  }

  const rel = segments.join("/");
  const first = segments[0] || "";

  const abs = path.join(SITE, ...segments);
  if (!abs.startsWith(SITE)) return send404(res);

  const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;

  if (stat && stat.isFile()) {
    serveFile(res, abs, first, wantsGzip);
    return;
  }

  if (stat && stat.isDirectory()) {
    // Extensionless deep link to a directory: redirect to the canonical
    // trailing-slash URL so relative asset URLs resolve (mirrors $uri/).
    if (!req.url.replace(/[?].*$/, "").endsWith("/")) {
      res.statusCode = 308;
      res.setHeader("Location", req.url.replace(/$/, "/").replace("//", "/"));
      applyHeaders(res, { "Content-Type": "text/plain" });
      res.end();
      return;
    }
    // Directory with trailing slash: serve its index.html revalidated.
    const indexFile = path.join(abs, "index.html");
    if (fs.existsSync(indexFile)) {
      serveFile(res, indexFile, first, wantsGzip);
      return;
    }
  }

  send404(res);
}

// ---------- /relay/ reverse proxy (HTTP + WS) to the relay service ----------
const proxy = RELAY_TARGET
  ? httpProxy.createProxyServer({
      target: RELAY_TARGET,
      changeOrigin: true,
      secure: true,
      // Long board sessions: no buffering, no idle kill.
      proxyTimeout: 3600_000,
      timeout: 3600_000,
    })
  : null;

proxy?.on("error", (err, req, res) => {
  console.error(`relay proxy error: ${err.message}`);
  if (res && !res.headersSent) {
    applyHeaders(res, { "Content-Type": "text/plain" });
    res.statusCode = 502;
    res.end("relay unreachable\n");
  }
});

function relayPath(url) {
  return url.replace(/^\/relay\/?/, "/");
}

const server = http.createServer((req, res) => {
  if (proxy && (req.url === "/relay" || req.url.startsWith("/relay/"))) {
    req.url = relayPath(req.url);
    return proxy.web(req, res);
  }
  serveSite(req, res);
});

if (proxy) {
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/bridge" || req.url.startsWith("/bridge?") || req.url.startsWith("/relay/")) {
      req.url = req.url.startsWith("/relay/") ? relayPath(req.url) : req.url;
      return proxy.ws(req, socket, head);
    }
    socket.destroy();
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      ev: "portal_up",
      port: PORT,
      relay: proxy ? RELAY_TARGET.replace(/[?&]token=[^&]*/, "***") : "disabled",
    })
  );
});
