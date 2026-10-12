/**
 * Live check: is the running DSH Host actually serving this plugin's bundle?
 *
 * Reproduces `artifactRevision` from `@deepseek-ai/dsh-client-modules`
 * (`framedHash("plugin-artifact", [mtimeMs, ctimeMs, size])`), builds the combo
 * route `/plugins/??<id>/client.js&rev=<rev>`, and asserts the response starts
 * with the bytes on disk. Any difference means the page is running stale code.
 *
 * Usage:
 *   node scripts/live-bundle.mjs [baseUrl]
 *
 * `baseUrl` defaults to `$DSH_WEB_URL`, then to http://127.0.0.1:19387. The
 * plugin id and bundle path come from this package's own package.json, so the
 * script stays correct if the package is renamed or moved. The bundle route
 * needs no authentication on a loopback Web carrier.
 */
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const clientExport = manifest.exports?.["./client"];
const clientPath = typeof clientExport === "string" ? clientExport : clientExport?.default;
if (typeof clientPath !== "string") {
	console.error("package.json has no string exports[\"./client\"]");
	process.exit(1);
}
const BUNDLE = fileURLToPath(new URL(clientPath, new URL("../", import.meta.url)));
const ID = manifest.name;
const BASE = (process.argv[2] ?? process.env.DSH_WEB_URL ?? "http://127.0.0.1:19387").replace(/\/+$/, "");

/** sha1 over a domain tag and length-framed fields; 12 hex chars. */
function framedHash(domain, parts) {
	const hash = createHash("sha1").update(domain).update("\0");
	for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
	return hash.digest("hex").slice(0, 12);
}

const stat = statSync(BUNDLE);
const rev = framedHash("plugin-artifact", [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)]);
console.log(`package  : ${manifest.name}@${manifest.version}  (${PACKAGE_DIR})`);
console.log(`bundle   : ${BUNDLE}`);
console.log(`size     : ${stat.size}`);
console.log(`rev      : ${rev}`);

const url = `${BASE}/plugins/??${ID}/client.js&rev=${rev}`;
console.log(`GET      : ${url}`);

let response;
try {
	response = await fetch(url);
} catch (error) {
	console.error(`request failed: ${error.message}`);
	console.error("Is the DSH Web GUI running at that address? Pass one as the first argument.");
	process.exit(1);
}
console.log(`status   : ${response.status} ${response.statusText}`);
if (!response.ok) {
	console.error("the Host does not serve this revision — the plugin may not be enabled in the profile");
	process.exit(1);
}

const served = await response.text();
const local = readFileSync(BUNDLE, "utf8");
console.log(`served   : ${Buffer.byteLength(served)} bytes`);
console.log(`local    : ${Buffer.byteLength(local)} bytes`);
// A combo response appends the composition terminator and a source-map trailer.
const trailer = served.slice(local.length);
console.log(`trailer  : ${JSON.stringify(trailer)}`);
if (!served.startsWith(local)) {
	console.error("served bytes differ from the file on disk — the page is running stale code");
	process.exit(2);
}
console.log("ok — the running Host serves this exact bundle");
