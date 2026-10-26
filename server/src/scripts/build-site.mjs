/* Build the combined site: 10 pinned WASM apps + repo bridge scripts + portal
 * shell, all served from one origin by the relay's portal middleware.
 *
 * This is the ONLY build script the combined deploy may use, because the Pxxl
 * builder runs the server/Dockerfile RUN stages with a build context of just
 * server/ (package.json, tsconfig.json, src/). Everything not inside src/ -
 * portal-node/, portal/, bridge/ - does not exist here, so the script pulls
 * the pinned upstream release zip (as the Dockerfile fetch stage does) plus
 * the fork's bridge scripts and portal shell over HTTPS from raw.githubusercontent.
 * Fails fast if any artifact is missing.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, renameSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import extractZip from "extract-zip";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/scripts
const SERVER = path.resolve(HERE, "..", "..");             // server/ (cwd at runtime)
const SITE = path.resolve(SERVER, process.env.SITE_DIR || "site");

// Fork files used by the runtime image (bridge scripts + portal shell). Pulled
// from main: deploys always build the pushed tip of main at the same time.
const REPO = process.env.REPO_REF || "Blvckpanda/craft-suite-railway";
const SRC_REF = "main";
const raw = (p) => `https://raw.githubusercontent.com/${REPO}/${SRC_REF}/${p}`;

// Pinned versions (bare semver). Release tags are v${VER}; upstream assets are
// ${repo}-web-${VER}.zip. The FilmCraft/PhotoCraft/PdfCraft web builds that
// ship in-page agent APIs are published from the fork — keep those pins.
const APPS = [
  { repo: "photocraft",  ver: "0.5.0-main4", url: process.env.PHOTOCRAFT_URL  || "https://github.com/derekcheungsa/craft-suite-railway/releases/download/photocraft-web-0.5.0-main4-0c72d95/photocraft-web-0.5.0-main4.zip" },
  { repo: "lightcraft",  ver: "0.4.0" },
  { repo: "pdfcraft",    ver: "0.5.0-main2", url: process.env.PDFCRAFT_URL    || "https://github.com/derekcheungsa/craft-suite-railway/releases/download/pdfcraft-web-0.5.0-main2-23f0675/pdfcraft-web-0.5.0-main2.zip" },
  { repo: "vectorcraft", ver: "0.7.0" },
  { repo: "filmcraft",   ver: "0.4.0-main",  url: process.env.FILMCRAFT_URL   || "https://github.com/derekcheungsa/craft-suite-railway/releases/download/filmcraft-web-0.4.0-main-7b6c134/filmcraft-web-0.4.0-main.zip" },
  { repo: "effectcraft", ver: "0.6.0" },
  { repo: "designcraft", ver: "0.13.0" },
  { repo: "figcraft",    ver: "0.11.2" },
  { repo: "soundcraft",  ver: "0.13.1" },
  { repo: "cadcraft",    ver: "0.13.0" },
];

// Combined deploy = one origin. The loader appends "/bridge" itself and
// upgrades relative URLs against location.origin, so the same-origin value is
// "/" — NOT "/bridge", which would double-append the bridge path.
const RELAY_URL = process.env.RELAY_URL || "/";

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "craft-suite-build" } });
  if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error(`suspiciously small artifact (${buf.length} B): ${url}`);
  writeFileSync(dest, buf);
}

async function fetchApp(app) {
  const url = app.url || `https://github.com/storytold/${app.repo}/releases/download/v${app.ver}/${app.repo}-web-${app.ver}.zip`;
  console.log(`fetching ${url}`);
  const tmpZip = path.join(SITE, `${app.repo}.zip`);
  await download(url, tmpZip);

  const tmpDir = path.join(SITE, `${app.repo}__extract`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  await extractZip(tmpZip, { dir: tmpDir });

  // Move the inner folder (its name may vary between forks) to SITE/<repo>.
  const entries = readdirSync(tmpDir).filter((e) => !e.startsWith("__MACOSX"));
  const target = path.join(SITE, app.repo);
  rmSync(target, { recursive: true, force: true });
  const inner = entries.length === 1 && statSync(path.join(tmpDir, entries[0])).isDirectory()
    ? entries[0]
    : null;
  if (inner) renameSync(path.join(tmpDir, inner), target);
  else renameSync(tmpDir, target);
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(tmpZip, { force: true });
}

/* GitHub's contents API gives the icon dir listing we can't stat locally. */
async function fetchJson(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "craft-suite-build" } });
  if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
  return await res.json();
}

async function fetchBridge() {
  const dir = path.join(SITE, "bridge");
  mkdirSync(dir, { recursive: true });
  for (const f of ["adapters.js", "loader.js"]) {
    await download(raw(`bridge/${f}`), path.join(dir, f));
  }
}

async function fetchPortal() {
  writeFileSync(path.join(SITE, "index.html"), await downloadText(raw("portal/index.html")));
  const entries = await fetchJson(`https://api.github.com/repos/${REPO}/contents/portal/icons?ref=${SRC_REF}`);
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("portal/icons listing empty");
  const iconDir = path.join(SITE, "icons");
  mkdirSync(iconDir, { recursive: true });
  for (const e of entries) {
    if (e.type !== "file") continue;
    await download(e.download_url, path.join(iconDir, e.name));
  }
}

async function downloadText(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "craft-suite-build" } });
  if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
  return await res.text();
}

// Build-scoped cache-busting query on the injected tags: intermediary caches
// along the Pxxl edge may extend asset freshness regardless of origin
// Cache-Control, and a versioned tag guarantees fresh bridge scripts after a
// redeploy.
const TAG_V = process.env.TAG_V || new Date().toISOString().replace(/\D/g, "").slice(0, 13);

function injectBridge() {
  writeFileSync(path.join(SITE, "bridge", "config.js"), `window.CRAFT_RELAY = { url: "${RELAY_URL}" };\n`);
  const tags = `\n<script src="/bridge/config.js?v=${TAG_V}"></script><script src="/bridge/adapters.js?v=${TAG_V}"></script><script src="/bridge/loader.js?v=${TAG_V}" defer></script>`;
  for (const app of APPS) {
    const index = path.join(SITE, app.repo, "index.html");
    if (!existsSync(index)) throw new Error(`${app.repo}: site has no index.html`);
    let html = readFileSync(index, "utf8");
    if (!html.includes("bridge/loader.js")) {
      html = html.replace("</body>", `${tags}</body>`);
      writeFileSync(index, html);
    }
  }
}

const GZIP_TYPES = [".wasm", ".js", ".html", ".json", ".css", ".svg", ".txt", ".webmanifest"];

function precompress(dir) {
  let files = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (!name.endsWith(".gz") && !name.endsWith(".orig") && st.size >= 860 && GZIP_TYPES.includes(path.extname(name))) {
        writeFileSync(p + ".gz", zlib.gzipSync(readFileSync(p), { level: 9 }));
        files++;
      }
    }
  };
  walk(dir);
  return files;
}

async function main() {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });

  await fetchBridge();
  await fetchPortal();

  const versions = {};
  for (const app of APPS) {
    versions[app.repo] = `v${app.ver}`;
    await fetchApp(app);
  }
  writeFileSync(path.join(SITE, "versions.json"), JSON.stringify(versions, null, 0) + "\n");

  injectBridge();
  const n = precompress(SITE);
  console.log(`site ready: ${APPS.length} apps, ${n} precompressed assets, versions ${JSON.stringify(versions)}`);
}

main().catch((e) => {
  console.error(`build-site failed: ${e.message}`);
  process.exit(1);
});
