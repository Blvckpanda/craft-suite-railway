/* Build-time fetch of the pinned upstream release artifacts — the Node/undocker
 * equivalent of the Dockerfile's fetch stage. Downloads each app's
 * `${repo}-web-${ver}.zip`, extracts it into /site/<repo> (tolerant of the
 * inner folder name), injects the relay bridge tags, precompresses payloads
 * and writes versions.json. Fails fast if any artifact is missing. */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, renameSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import extractZip from "extract-zip";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");           // portal-node/
const REPOROOT = path.resolve(ROOT, "..");       // repository root
const SITE = path.join(ROOT, "site");

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

const RELAY_URL = process.env.RELAY_URL || "/relay";

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`suspiciously small artifact (${buf.length} B): ${url}`);
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
  // Pure-JS unzip: the Pxxl free build image cannot be assumed to ship the
  // unzip binary.
  await extractZip(tmpZip, { dir: tmpDir });

  // Move the inner folder (its name may vary between forks) to /site/<repo>.
  const entries = readdirSync(tmpDir).filter((e) => !e.startsWith("__MACOSX"));
  const target = path.join(SITE, app.repo);
  rmSync(target, { recursive: true, force: true });
  const inner = entries.length === 1 && statSync(path.join(tmpDir, entries[0])).isDirectory()
    ? entries[0]
    : null;
  if (inner) renameSync(path.join(tmpDir, inner), target);
  else renameSync(tmpDir, target);
  rmSync(tmpZip, { force: true });
}

function injectBridge() {
  mkdirSync(path.join(SITE, "bridge"), { recursive: true });
  writeFileSync(path.join(SITE, "bridge", "config.js"), `window.CRAFT_RELAY = { url: "${RELAY_URL}" };\n`);
  for (const app of APPS) {
    const index = path.join(SITE, app.repo, "index.html");
    if (!existsSync(index)) throw new Error(`${app.repo}: site has no index.html`);
    let html = readFileSync(index, "utf8");
    if (!html.includes("bridge/loader.js")) {
      html = html.replace(
        "</body>",
        `<script src="/bridge/config.js"></script><script src="/bridge/adapters.js"></script><script src="/bridge/loader.js" defer></script></body>`
      );
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

  // Static bridge scripts ship in the repo; config.js is generated above.
  const bridgeSrc = path.join(REPOROOT, "bridge");
  mkdirSync(path.join(SITE, "bridge"), { recursive: true });
  for (const f of readdirSync(bridgeSrc)) {
    if (f.endsWith(".js")) copyFileSync(path.join(bridgeSrc, f), path.join(SITE, "bridge", f));
  }

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
  console.error(`fetch-apps failed: ${e.message}`);
  process.exit(1);
});
