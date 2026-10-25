/* Static portal mount for the combined single-service deployment.
 *
 * Serves the fetched WASM apps, the injected bridge scripts and the portal
 * index from one origin — the Node equivalent of the nginx config in the
 * Docker build (correct MIME so .wasm never lands as octet-stream, per-app
 * cache rules, COOP/COEP/CORP, precompressed .gz copies) plus the same-origin
 * /mcp + /bridge the relay itself provides. Mounted ONLY when the site
 * directory is present, so the relay keeps working standalone.
 */
import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";

const MIME: Record<string, string> = {
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
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  xml: "application/xml",
  "wasm.orig": "application/octet-stream",
};

// Hashed, immutable assets live in these apps; hashed names mean versioned
// URLs are safe to cache forever (nginx's wasm|js location). lightcraft and
// effectcraft ship unhashed filenames and must always revalidate.
const IMMUTABLE_APPS = new Set([
  "photocraft", "pdfcraft", "vectorcraft", "filmcraft",
  "designcraft", "figcraft", "soundcraft", "cadcraft",
]);

const SECURITY_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

function applyHeaders(res: Response, extra: Record<string, string>) {
  const h = { ...SECURITY_HEADERS, ...extra };
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function send404(res: Response) {
  applyHeaders(res, { "Content-Type": "text/plain" });
  res.statusCode = 404;
  res.end("404\n");
}

/* Segments from the raw, decoded URL — never from path.normalize, which
 * flips slashes on win32 and would break first-segment cache lookups. */
function parsePath(urlString: string): string[] | null {
  let raw: string;
  try {
    raw = decodeURIComponent((urlString || "/").split("?")[0]);
  } catch {
    return null; // malformed %-encoding
  }
  return raw
    .split("/")
    .filter((s) => s.length > 0 && s !== ".." && s !== ".")
    .map((s) => s);
}

function redirect308(res: Response, url: string) {
  applyHeaders(res, { "Content-Type": "text/plain" });
  res.statusCode = 308;
  res.setHeader("Location", url);
  res.end();
}

function serveFile(req: Request, res: Response, absFile: string, first: string) {
  const ext = path.extname(absFile).slice(1).toLowerCase();
  //"x.wasm.orig" has extname ".orig"; the explicit nginx type applies to the
  // full basename suffix instead.
  const suffix = path.basename(absFile).toLowerCase().endsWith(".wasm.orig")
    ? "wasm.orig"
    : ext;
  const headers: Record<string, string> = {
    "Content-Type": MIME[suffix] || "application/octet-stream",
  };
  const immutable = IMMUTABLE_APPS.has(first) && /\.(wasm|js)$/.test(absFile);
  headers["Cache-Control"] = immutable
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  const wantsGzip = (req.headers["accept-encoding"] || "").includes("gzip");
  let readPath = absFile;
  if (wantsGzip && fs.existsSync(absFile + ".gz")) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    readPath = absFile + ".gz";
  }
  const stat = fs.statSync(readPath);
  headers["Content-Length"] = String(stat.size);
  applyHeaders(res, headers);
  res.statusCode = 200;
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(readPath).pipe(res);
}

export function portalMiddleware(site: string) {
  return (req: Request, res: Response) => {
    const segments = parsePath(req.url);
    if (segments === null) return send404(res);

    // Root "/" serves the portal index directly (Docker's COPY portal/).
    if (segments.length === 0) {
      const indexFile = path.join(site, "index.html");
      if (fs.existsSync(indexFile)) return serveFile(req, res, indexFile, "");
      return send404(res);
    }

    const first = segments[0];
    const abs = path.join(site, ...segments);
    if (!abs.startsWith(site)) return send404(res);

    let stat: fs.Stats | null = null;
    try {
      stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
    } catch {
      stat = null;
    }

    if (stat?.isFile()) {
      return serveFile(req, res, abs, first);
    }

    if (stat?.isDirectory()) {
      // Extensionless deep link to a directory: redirect to the canonical
      // trailing-slash URL so relative asset URLs resolve (mirrors $uri/).
      const [pathname, ...query] = (req.url || "/").split("?");
      if (!pathname.endsWith("/")) {
        return redirect308(res, query.length ? `${pathname}/?${query.join("?")}` : `${pathname}/`);
      }
      // Directory with trailing slash: serve its index.html revalidated.
      const indexFile = path.join(abs, "index.html");
      if (fs.existsSync(indexFile)) return serveFile(req, res, indexFile, first);
      return send404(res);
    }

    return send404(res);
  };
}
