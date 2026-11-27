// node --test test/player_plugin_v2.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_VERSION,
  CONTROLLER_METHODS_V2,
  EVENTS_V2,
  HOST_SERVICES,
  assertControllerV2,
  assertSeekIdempotent,
  argCheck,
  detectCapabilitiesV2,
  validateStateVar,
  validateDiagnostic,
} from "../harness/plugin_contract.js";
import {
  SANDBOX_ATTR,
  SANDBOX_ATTR_MODE_B,
  OPFS_PROBE_TIMEOUT_MS,
  assertSandbox,
  selectMountMode,
  validateMessageV2,
  createSandboxedPlayerV2,
  sha384Base64,
} from "../harness/iframe_bridge.js";
import { createPlayer as createMinimalSlides } from "../players/minimal-slides/index.js";
import { createPlayer as createLiveTeacherTile } from "../players/live-teacher-tile-stub/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleLesson = JSON.parse(fs.readFileSync(path.join(root, "spec", "sample-lesson.json"), "utf8"));

class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = "";
    this.contentWindow = { posted: [], postMessage(...a) { this.posted.push(a); } };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
}

function makeFakeContainer() {
  const doc = { createElement: (t) => new FakeEl(t) };
  const container = new FakeEl("div");
  container.ownerDocument = doc;
  return container;
}

function makeEnv(fetchImpl) {
  const listeners = [];
  return {
    listeners,
    document: { createElement: (t) => new FakeEl(t) },
    crypto: webcrypto,
    fetch: fetchImpl,
    MessageChannel,
    addEventListener: (_t, fn) => listeners.push(fn),
    removeEventListener: (_t, fn) => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };
}

test("v2 contract removes telemetry.reportPlayback and requires appendBeats/setLayout", () => {
  assert.equal(CONTRACT_VERSION, 2);
  assert.ok(CONTROLLER_METHODS_V2.includes("appendBeats"));
  assert.ok(CONTROLLER_METHODS_V2.includes("setLayout"));
  assert.ok(EVENTS_V2.includes("statechange_var"));
  assert.ok(EVENTS_V2.includes("diagnostic"));
  assert.equal("telemetry" in HOST_SERVICES, false);
  const caps = detectCapabilitiesV2({ tts: { synthesizeStream() {} }, telemetry: { reportPlayback() {} } });
  assert.deepEqual(caps, { tts: true, realtime: false, tutor: false });
});

test("assertSandbox enforces Mode A opacity and Mode B *.didactum-sandbox.org origin isolation", () => {
  assert.equal(assertSandbox("allow-scripts"), SANDBOX_ATTR);
  assert.throws(() => assertSandbox("allow-scripts allow-same-origin"), /allow-same-origin/);
  assert.throws(
    () => assertSandbox("allow-scripts allow-same-origin", {
      mode: "B",
      origin: "https://didactum.org",
      hostOrigin: "https://didactum.org",
    }),
    /sandbox_escape|verified cross-site/,
  );
  assert.throws(
    () => assertSandbox("allow-scripts allow-same-origin", {
      mode: "B",
      origin: "https://evil.example.com",
      hostOrigin: "https://didactum.org",
    }),
    /verified cross-site/,
  );
  assert.throws(
    () => assertSandbox("allow-scripts allow-same-origin", {
      mode: "B",
      origin: "http://local-voice.didactum-sandbox.org",
      hostOrigin: "https://didactum.org",
    }),
    /verified cross-site/,
  );
  assert.equal(
    assertSandbox("allow-scripts allow-same-origin", {
      mode: "B",
      origin: "https://local-voice.didactum-sandbox.org",
      hostOrigin: "https://didactum.org",
    }),
    SANDBOX_ATTR_MODE_B,
  );
});

test("selectMountMode defaults to Mode A and falls back to Mode A within 150ms when Mode B /healthz is blocked or times out", async () => {
  assert.equal(OPFS_PROBE_TIMEOUT_MS, 150);

  // Default player (no persistentOpfs) uses Mode A with zero network probes
  let called = false;
  const def = await selectMountMode({
    playerId: "minimal-slides",
    capabilities: { tts: true },
    fetch: async () => { called = true; return { ok: true }; },
  });
  assert.equal(def.mode, "A");
  assert.equal(def.fallback, false);
  assert.equal(called, false);

  // Opt-in persistentOpfs + healthy cross-site /healthz -> Mode B
  const okModeB = await selectMountMode({
    playerId: "local-voice",
    capabilities: { persistentOpfs: true },
    hostOrigin: "https://didactum.org",
    fetch: async (url) => {
      assert.equal(url, "https://local-voice.didactum-sandbox.org/healthz");
      return { ok: true };
    },
  });
  assert.equal(okModeB.mode, "B");
  assert.equal(okModeB.sandboxOrigin, "https://local-voice.didactum-sandbox.org");
  assert.equal(okModeB.fallback, false);

  // Firewall CORS/network rejection -> automatic fallback to Mode A
  const blocked = await selectMountMode({
    playerId: "local-voice",
    capabilities: { persistentOpfs: true },
    hostOrigin: "https://didactum.org",
    fetch: async () => { throw new TypeError("Failed to fetch"); },
  });
  assert.equal(blocked.mode, "A");
  assert.equal(blocked.fallback, true);
  assert.equal(blocked.reason, "probe_blocked");

  // Firewall silent drop / timeout >150ms -> automatic fallback to Mode A
  const t0 = Date.now();
  const timedOut = await selectMountMode({
    playerId: "local-voice",
    capabilities: { persistentOpfs: true },
    hostOrigin: "https://didactum.org",
    fetch: () => new Promise(() => {}),
  });
  const elapsed = Date.now() - t0;
  assert.equal(timedOut.mode, "A");
  assert.equal(timedOut.fallback, true);
  assert.equal(timedOut.reason, "probe_timeout");
  assert.ok(elapsed < 400, `probe timeout took too long: ${elapsed}ms`);
});

test("v2 bridge rejects telemetry.reportPlayback, free-text statechange_var, and attestation diagnostics", () => {
  const ctx = {
    token: "tok2",
    direction: "toHost",
    declaredVars: { x: { type: "number", min: 0, max: 100 }, mode: { type: "enum", values: ["grid", "polar"] } },
  };
  assert.throws(
    () => validateMessageV2({ v: 2, token: "tok2", kind: "req", id: 1, method: "host.telemetry.reportPlayback", params: [{ playedMs: 1000 }] }, ctx),
    (e) => e.code === "unauthorized",
  );
  // Bounded declared state works
  const okVar = { v: 2, token: "tok2", kind: "evt", event: "statechange_var", payload: { var: "x", value: 30 } };
  assert.equal(validateMessageV2(okVar, ctx), okVar);
  // Out-of-bounds / undeclared / free-text rejected
  assert.throws(() => validateMessageV2({ ...okVar, payload: { var: "x", value: 999 } }, ctx));
  assert.throws(() => validateMessageV2({ ...okVar, payload: { var: "unknown", value: 1 } }, ctx));
  assert.throws(() => validateStateVar({ var: "reply", value: "free text answer from student" }));
  // Diagnostic coarse enum/int works; playback attestation rejected
  assert.equal(validateDiagnostic({ code: "codec_fallback", count: 1, level: "warn" }).code, "codec_fallback");
  assert.throws(() => validateDiagnostic({ code: "done", completed: true }));
  assert.throws(() => validateDiagnostic({ code: "done", progress: 100 }));
});

test("interrupt v2 requires structured reason only and rejects raw student text or media streams", () => {
  assert.deepEqual(argCheck.interruptV2({ reason: "barge_in" }), { reason: "barge_in" });
  assert.throws(() => argCheck.interruptV2("raw student text"));
  assert.throws(() => argCheck.interruptV2({ reason: "barge_in", text: "what is the answer?" }));
  assert.throws(() => argCheck.interruptV2({ reason: "barge_in", audioStream: {} }));
  assert.throws(() => argCheck.interruptV2({ reason: "barge_in", camera: true }));
});

test("minimal-slides and live-teacher-tile-stub pass v2 contract, appendBeats, setLayout, and seek idempotence", async () => {
  const beatIds = (sampleLesson.chapters || sampleLesson.acts).flatMap((c) => c.beats.map((b) => b.id)).slice(0, 3);
  for (const createPlayer of [createMinimalSlides, createLiveTeacherTile]) {
    const container = makeFakeContainer();
    const ctrl = createPlayer(container, { lesson: sampleLesson, host: {}, capabilities: {} });
    assertControllerV2(ctrl);
    await ctrl.mount();
    await assertSeekIdempotent(ctrl, beatIds);
    ctrl.appendBeats([{ id: "branch-1", origin: "host", narration: { text: "Remediation beat." } }]);
    ctrl.seekBeat("branch-1", { offsetMs: 25, seed: 7 });
    assert.equal(ctrl.getSceneState().beatId, "branch-1");
    ctrl.setLayout({
      rect: { x: 0, y: 0, width: 390, height: 844 },
      safe_rect: { x: 8, y: 8, width: 374, height: 756 },
      occluded: false,
      orientation: "portrait",
      teacher_tile_mode: "subtitle_dock",
    });
    assert.equal(ctrl.getSceneState().layout.teacher_tile_mode, "subtitle_dock");
    await ctrl.interrupt({ reason: "student_speech" });
    ctrl.destroy();
  }
});

test("Mode A bridge transfers SRI-verified ESM + assets over MessagePort and enforces v2 rules", async () => {
  const pluginSrc = "export function createPlayer(){ return { mount(){}, destroy(){} }; }";
  const assetBytes = new TextEncoder().encode("mesh-binary-payload");
  const pluginSri = await sha384Base64(pluginSrc, webcrypto.subtle);
  const assetSri = await sha384Base64(assetBytes, webcrypto.subtle);

  const env = makeEnv(async (url) => {
    if (url === "/p.js") return { ok: true, status: 200, text: async () => pluginSrc };
    if (url === "/mesh.bin") return { ok: true, status: 200, arrayBuffer: async () => assetBytes.slice().buffer };
    return { ok: false, status: 404 };
  });

  const ctrl = createSandboxedPlayerV2(new FakeEl("div"), {
    pluginUrl: "/p.js",
    sri: pluginSri,
    lesson: { id: "l2" },
    assets: [{ name: "mesh.bin", url: "/mesh.bin", sri: assetSri, mimeType: "application/octet-stream" }],
    host: { tts: { synthesizeStream: async () => ({ ok: true }) }, telemetry: { reportPlayback: async () => {} } },
    env,
  });

  try {
    await env.listeners[0]({ source: ctrl.frame.contentWindow, data: { type: "didactum-hello" } });
    const [initMsg, targetOrigin, transfer] = ctrl.frame.contentWindow.posted[0];
    assert.equal(targetOrigin, "*");
    assert.equal(initMsg.bridgeVersion, 2);
    assert.deepEqual(initMsg.capabilities, { tts: true, realtime: false, tutor: false });
    assert.equal(initMsg.assets.length, 1);
    assert.equal(initMsg.assets[0].name, "mesh.bin");
    assert.equal(transfer.length, 2); // MessagePort + asset ArrayBuffer

    // Attempting host.telemetry.reportPlayback over v2 port is dropped/rejected
    const port = transfer[0];
    const got = [];
    port.onmessage = (e) => got.push(e.data);
    port.postMessage({ v: 2, token: initMsg.token, kind: "req", id: 1, method: "host.telemetry.reportPlayback", params: [{}] });
    port.postMessage({ v: 2, token: initMsg.token, kind: "req", id: 2, method: "host.tts.synthesizeStream", params: ["hi"] });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.length, 1);
    assert.equal(got[0].id, 2);

    port.postMessage({ v: 2, token: initMsg.token, kind: "evt", event: "ready", payload: null });
    await ctrl.mount();
  } finally {
    await ctrl.destroy();
  }
});
