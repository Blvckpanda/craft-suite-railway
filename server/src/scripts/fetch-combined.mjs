/* Combined single-service build steps for hosts whose build sandbox copies
 * only known paths into the build dir (observed on Pxxl Free: package.json,
 * tsconfig.json and src/, but not new top-level directories), so this script
 * lives inside src/ and runs from the "build" npm script with cwd = server/.
 *
 * 1. fetch the 10 pinned upstream WASM apps into ./site (cwd-relative, see
 *    portal-node/scripts/fetch-apps.mjs), with the bridge configured for the
 *    same origin (RELAY_URL_SAME_ORIGIN) instead of the portal-proxy path;
 * 2. copy the portal index and app icons to the site root (the Docker build
 *    does this via `COPY portal/`); the relay's static middleware serves
 *    everything from one origin.
 */
import path from "node:path";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.RELAY_URL_SAME_ORIGIN ||= "1";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/scripts
const SERVER_DIR = path.resolve(HERE, "..", "..");         // server/
const SITE = path.join(SERVER_DIR, "site");
const PORTAL = path.resolve(SERVER_DIR, "..", "portal");   // portal/

await import(pathToFileURL(path.join(PORTAL, "..", "portal-node", "scripts", "fetch-apps.mjs")).href);

copyFileSync(path.join(PORTAL, "index.html"), path.join(SITE, "index.html"));
mkdirSync(path.join(SITE, "icons"), { recursive: true });
for (const f of readdirSync(path.join(PORTAL, "icons"))) {
  const p = path.join(PORTAL, "icons", f);
  if (statSync(p).isFile()) copyFileSync(p, path.join(SITE, "icons", f));
}
console.log("combined build: portal index + icons copied into site/");
