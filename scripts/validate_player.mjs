// node scripts/validate_player.mjs [--update-sri]   — registry SRI + static safety scan + v2 contract & seek-idempotence smoke test.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assertController, assertControllerV2, assertPluginModule, assertSeekIdempotent } from "../harness/plugin_contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const regPath = path.join(root, "players-registry.json");
const update = process.argv.includes("--update-sri");
const registry = JSON.parse(fs.readFileSync(regPath, "utf8"));
const FORBIDDEN = [
  [/\beval\s*\(/, "eval()"], [/new\s+Function\s*\(/, "new Function()"], [/allow-same-origin/, "allow-same-origin"],
  [/\b(?:window\.)?(?:parent|top)\s*\.\s*(?:document|location|postMessage)/, "touching parent/top"],
  [/document\.cookie|localStorage|sessionStorage|indexedDB/, "storage access"],
  [/\bimport\s*\(\s*["'`]https?:/, "remote import"], [/\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(/, "direct network (use host services)"],
  [/telemetry\s*\.\s*reportPlayback/, "untrusted telemetry.reportPlayback"],
];
const sample = JSON.parse(fs.readFileSync(path.join(root, "spec", "sample-lesson.json"), "utf8"));
const sampleBeatIds = (sample.chapters || sample.acts).flatMap((c) => c.beats.map((b) => b.id));
const errors = [];

function fakeDoc() {
  const el = () => ({ children: [], style: {}, attrs: {}, textContent: "", setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { c.parentNode = this; this.children.push(c); }, removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; } });
  const doc = { createElement: () => el() };
  const container = el(); container.ownerDocument = doc; return container;
}

for (const entry of registry.players) {
  const file = path.join(root, entry.path);
  if (!path.resolve(file).startsWith(path.join(root, "players") + path.sep) || !fs.existsSync(file)) { errors.push(`${entry.id}: bad path ${entry.path}`); continue; }
  const src = fs.readFileSync(file);
  const sri = "sha384-" + crypto.createHash("sha384").update(src).digest("base64");
  if (update) entry.sri = sri;
  else if (entry.sri !== sri) errors.push(`${entry.id}: SRI mismatch (run npm run sri)`);
  for (const [re, what] of FORBIDDEN) if (re.test(src.toString("utf8"))) errors.push(`${entry.id}: forbidden ${what}`);
  try {
    const mod = assertPluginModule(await import(pathToFileURL(file).href));
    const ctrl = mod.createPlayer(fakeDoc(), { lesson: sample, host: {}, capabilities: {} });
    if (entry.contractVersion === 2 || ctrl.contractVersion === 2) assertControllerV2(ctrl);
    else assertController(ctrl);
    const seen = [];
    ctrl.on("ready", () => seen.push("ready"));
    await ctrl.mount();
    if (ctrl.contractVersion === 2) {
      await assertSeekIdempotent(ctrl, sampleBeatIds.slice(0, 3));
      ctrl.appendBeats([{ id: "rem-1", origin: "host", narration: { text: "Try breaking it down." } }]);
      ctrl.seekBeat("rem-1", { offsetMs: 10, seed: 42 });
      ctrl.setLayout({
        rect: { x: 0, y: 0, width: 390, height: 844 },
        safe_rect: { x: 8, y: 8, width: 374, height: 756 },
        occluded: false,
        orientation: "portrait",
        teacher_tile_mode: "subtitle_dock",
      });
      await ctrl.interrupt({ reason: "barge_in" });
    } else {
      ctrl.seekBeat(1); ctrl.setTheme("white"); ctrl.setCaptions(false);
      await ctrl.interrupt("why?");
    }
    ctrl.setTheme("white");
    ctrl.setCaptions(false);
    ctrl.destroy();
    if (!seen.includes("ready")) errors.push(`${entry.id}: no 'ready' event on mount()`);
  } catch (err) { errors.push(`${entry.id}: contract smoke test failed: ${err.message}`); }
}
if (update) { fs.writeFileSync(regPath, JSON.stringify(registry, null, 2) + "\n"); console.log("SRI updated"); }
else if (errors.length) { console.error(errors.join("\n")); console.error(`FAILED: ${errors.length} problem(s)`); process.exit(1); }
else console.log(`OK: ${registry.players.length} player(s)`);
