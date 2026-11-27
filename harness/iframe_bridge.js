// Dual-mount sandbox bridge (PlayerPlugin v2 with v1 compatibility):
// - Mode A (default): opaque-origin <iframe sandbox="allow-scripts"> srcdoc on main origin (NEVER allow-same-origin).
// - Mode B (opt-in persistentOpfs): cross-site https://<player-id>.didactum-sandbox.org with 150ms CORS /healthz probe.
import {
  CONTRACT_VERSION_V1,
  CONTRACT_VERSION_V2,
  CONTROLLER_METHODS_V1,
  CONTROLLER_METHODS_V2,
  EVENTS_V1,
  EVENTS_V2,
  HOST_SERVICES_V1,
  HOST_SERVICES_V2,
  ContractError,
  createEmitter,
  argCheck,
  detectCapabilities,
  validateStateVar,
  validateDiagnostic,
} from "./plugin_contract.js";

export const SANDBOX_ATTR = "allow-scripts";
export const SANDBOX_ATTR_MODE_B = "allow-scripts allow-same-origin";
export const SANDBOX_ORIGIN_SUFFIX = ".didactum-sandbox.org";
export const OPFS_PROBE_TIMEOUT_MS = 150;
export const BRIDGE_VERSION = 1;
export const BRIDGE_VERSION_V2 = 2;

const MAX_MESSAGE_BYTES = 256 * 1024;
const HOST_CALLS_V1 = new Set(Object.entries(HOST_SERVICES_V1).flatMap(([s, fns]) => fns.map((f) => `${s}.${f}`)));
const HOST_CALLS_V2 = new Set(Object.entries(HOST_SERVICES_V2).flatMap(([s, fns]) => fns.map((f) => `${s}.${f}`)));

export class BridgeError extends Error {
  constructor(message, code = "bridge_error") { super(message); this.name = "BridgeError"; this.code = code; }
}

/** Checks that `origin` is a verified cross-site `https://<player-id>.didactum-sandbox.org` origin, distinct from `hostOrigin`. */
export function isVerifiedSandboxOrigin(origin, hostOrigin) {
  if (typeof origin !== "string" || !origin || origin === "null") return false;
  let parsed;
  try { parsed = new URL(origin); } catch (_) { return false; }
  if (parsed.protocol !== "https:" || parsed.origin !== origin) return false;
  if (parsed.username || parsed.password) return false;
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.didactum-sandbox\.org$/.test(parsed.hostname)) return false;
  const effectiveHostOrigin = hostOrigin !== undefined
    ? hostOrigin
    : (typeof globalThis !== "undefined" && globalThis.location ? globalThis.location.origin : null);
  if (effectiveHostOrigin && effectiveHostOrigin !== "null") {
    if (parsed.origin === effectiveHostOrigin) return false;
    try {
      const hostParsed = new URL(effectiveHostOrigin);
      if (parsed.hostname === hostParsed.hostname) return false;
    } catch (_) { /* non-URL hostOrigin string already checked by equality */ }
  }
  return true;
}

export function buildSandboxOrigin(playerId) {
  if (typeof playerId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(playerId)) {
    throw new BridgeError("invalid playerId for sandbox origin", "bad_options");
  }
  return `https://${playerId}${SANDBOX_ORIGIN_SUFFIX}`;
}

/**
 * Mode A forbids `allow-same-origin`.
 * Mode B permits `allow-same-origin` ONLY on a verified cross-site `*.didactum-sandbox.org` origin (NEVER on host origin).
 */
export function assertSandbox(value, opts = {}) {
  const tokens = String(value || "").split(/\s+/).filter(Boolean);
  if (opts && opts.mode === "B") {
    if (!isVerifiedSandboxOrigin(opts.origin, opts.hostOrigin)) {
      throw new BridgeError("allow-same-origin requires a verified cross-site *.didactum-sandbox.org origin", "sandbox_escape");
    }
    const allowed = new Set(["allow-scripts", "allow-same-origin"]);
    if (tokens.length !== 2 || !tokens.includes("allow-scripts") || !tokens.includes("allow-same-origin") || tokens.some((t) => !allowed.has(t))) {
      throw new BridgeError(`Mode B sandbox must be exactly "${SANDBOX_ATTR_MODE_B}"`, "sandbox_escape");
    }
    return SANDBOX_ATTR_MODE_B;
  }
  if (tokens.includes("allow-same-origin")) throw new BridgeError("allow-same-origin is forbidden for community players", "sandbox_escape");
  if (tokens.length !== 1 || tokens[0] !== SANDBOX_ATTR) throw new BridgeError(`sandbox must be exactly "${SANDBOX_ATTR}"`, "sandbox_escape");
  return SANDBOX_ATTR;
}

/**
 * Dual-mount selector: Mode A is the zero-domain default.
 * Only when `capabilities.persistentOpfs === true` does it run a 150ms CORS `/healthz` preflight probe
 * against `https://<player-id>.didactum-sandbox.org/healthz`; on firewall block or timeout it falls back to Mode A.
 */
export async function selectMountMode(opts = {}) {
  const {
    playerId,
    capabilities = {},
    hostOrigin,
    sandboxOrigin: explicitSandboxOrigin,
    fetch: fetchFn = globalThis.fetch,
    timeoutMs = OPFS_PROBE_TIMEOUT_MS,
  } = opts;
  if (!capabilities || capabilities.persistentOpfs !== true) {
    return { mode: "A", reason: "default_mode_a", sandboxOrigin: null, probeMs: 0, fallback: false };
  }
  let sandboxOrigin = explicitSandboxOrigin;
  if (!sandboxOrigin) {
    try { sandboxOrigin = buildSandboxOrigin(playerId); } catch (_) { sandboxOrigin = null; }
  }
  if (!isVerifiedSandboxOrigin(sandboxOrigin, hostOrigin)) {
    return { mode: "A", reason: "invalid_sandbox_origin", sandboxOrigin: null, probeMs: 0, fallback: true };
  }
  if (typeof fetchFn !== "function") {
    return { mode: "A", reason: "probe_unavailable", sandboxOrigin: null, probeMs: 0, fallback: true };
  }

  const started = Date.now();
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  let timedOut = false;

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (ac) { try { ac.abort("opfs_probe_timeout"); } catch (_) {} }
      resolve({ ok: false, timedOut: true });
    }, timeoutMs);
  });

  const probePromise = Promise.resolve()
    .then(() => fetchFn(`${sandboxOrigin}/healthz`, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      signal: ac ? ac.signal : undefined,
    }))
    .then((res) => ({ ok: !!(res && res.ok), timedOut: false }))
    .catch(() => ({ ok: false, timedOut }));

  try {
    const outcome = await Promise.race([probePromise, timeoutPromise]);
    const probeMs = Math.max(0, Date.now() - started);
    if (!timedOut && outcome && outcome.ok) {
      return { mode: "B", reason: "opfs_probe_ok", sandboxOrigin, probeMs, fallback: false };
    }
    return {
      mode: "A",
      reason: timedOut || (outcome && outcome.timedOut) ? "probe_timeout" : "probe_blocked",
      sandboxOrigin: null,
      probeMs,
      fallback: true,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Strict envelope validation for messages arriving on the bridge port.
 *   host -> player:  {v, token, kind:"req", id, method, params}
 *   player -> host:  {v, token, kind:"res", id, ok, result|error}  |  {v, token, kind:"evt", event, payload}
 *                    {v, token, kind:"req", id, method:"host.<svc>.<fn>", params}
 * `direction` is "toHost" (what the host accepts) or "toPlayer".
 */
export function validateMessage(msg, { token, direction, version = BRIDGE_VERSION, declaredVars } = {}) {
  const bad = (why) => { throw new BridgeError(why, "bad_message"); };
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) bad("message must be an object");
  const expectedVersion = version === BRIDGE_VERSION_V2 ? BRIDGE_VERSION_V2 : BRIDGE_VERSION;
  if (msg.v !== expectedVersion) bad("unsupported bridge version");
  if (typeof msg.token !== "string" || msg.token !== token) throw new BridgeError("bad token", "unauthorized");
  let size = 0;
  try { size = JSON.stringify(msg).length; } catch (_) { bad("message not serialisable"); }
  if (size > MAX_MESSAGE_BYTES) bad("message too large");

  const isV2 = expectedVersion === BRIDGE_VERSION_V2;
  const hostCalls = isV2 ? HOST_CALLS_V2 : HOST_CALLS_V1;
  const controllerMethods = isV2 ? CONTROLLER_METHODS_V2 : CONTROLLER_METHODS_V1;
  const allowedEvents = isV2 ? EVENTS_V2 : EVENTS_V1;

  switch (msg.kind) {
    case "req":
      if (!Number.isInteger(msg.id) || msg.id < 1) bad("req needs integer id");
      if (typeof msg.method !== "string") bad("req needs method");
      if (direction === "toHost"
        ? !(msg.method.startsWith("host.") && hostCalls.has(msg.method.slice(5)))
        : !controllerMethods.includes(msg.method)) {
        throw new BridgeError(`method not allowed: ${msg.method}`, "unauthorized");
      }
      if (msg.params !== undefined && !Array.isArray(msg.params)) bad("params must be an array");
      break;
    case "res":
      if (!Number.isInteger(msg.id) || typeof msg.ok !== "boolean") bad("res needs id and ok");
      break;
    case "evt":
      if (direction !== "toHost") bad("events only flow to the host");
      if (!allowedEvents.includes(msg.event)) throw new BridgeError(`unknown event: ${msg.event}`, "bad_message");
      if (isV2 && msg.event === "statechange_var") {
        try { validateStateVar(msg.payload, declaredVars); } catch (err) { bad(err.message); }
      }
      if (isV2 && msg.event === "diagnostic") {
        try { validateDiagnostic(msg.payload); } catch (err) { bad(err.message); }
      }
      break;
    default: bad("unknown kind");
  }
  return msg;
}

export function validateMessageV2(msg, ctx = {}) {
  return validateMessage(msg, { ...ctx, version: BRIDGE_VERSION_V2 });
}

export async function sha384Base64(data, subtle) {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : (data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  const buf = await subtle.digest("SHA-384", bytes);
  let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return `sha384-${btoa(s)}`;
}

// Runs INSIDE the sandboxed iframe: waits for the host's port, proxies host services over RPC, mounts the plugin.
export const BOOTSTRAP_SRC = `
let BV = ${BRIDGE_VERSION};
let port, token, nextId = 1; const pending = new Map();
function send(m) { port.postMessage({ v: BV, token, ...m }); }
function callHost(method, args) {
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ kind: "req", id, method: "host." + method, params: args }); });
}
const baseHost = { tts: { synthesizeStream: (...a) => callHost("tts.synthesizeStream", a) },
  realtime: { connect: (...a) => callHost("realtime.connect", a) },
  tutor: { ask: (...a) => callHost("tutor.ask", a) } };
let ctrl = null;
async function onMsg(e) {
  const m = e.data; if (!m || m.token !== token) return;
  if (m.kind === "res") { const p = pending.get(m.id); pending.delete(m.id); if (p) (m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))); return; }
  if (m.kind !== "req") return;
  try {
    if (!ctrl) throw new Error("not ready");
    const result = await ctrl[m.method](...(m.params || []));
    send({ kind: "res", id: m.id, ok: true, result: result === undefined ? null : result });
  } catch (err) { send({ kind: "res", id: m.id, ok: false, error: String(err && err.message || err) }); }
}
window.addEventListener("message", async (e) => {
  if (!e.data || e.data.type !== "didactum-init" || port) return;
  if (e.data.bridgeVersion) BV = e.data.bridgeVersion;
  const host = BV >= 2 ? baseHost : { ...baseHost, telemetry: { reportPlayback: (...a) => callHost("telemetry.reportPlayback", a) } };
  const evList = BV >= 2 ? ${JSON.stringify(EVENTS_V2)} : ${JSON.stringify(EVENTS_V1)};
  port = e.ports[0]; token = e.data.token; port.onmessage = onMsg;
  try {
    const mod = await import(e.data.moduleUrl);
    const container = document.getElementById("root");
    ctrl = mod.createPlayer(container, { lesson: e.data.lesson, host, capabilities: e.data.capabilities, assets: e.data.assets || [] });
    for (const ev of evList) if (ev !== "ready") ctrl.on(ev, (payload) => send({ kind: "evt", event: ev, payload }));
    await ctrl.mount();
    send({ kind: "evt", event: "ready", payload: null });
  } catch (err) { send({ kind: "evt", event: "error", payload: { message: String(err && err.message || err) } }); }
});
parent.postMessage({ type: "didactum-hello" }, "*");
`;

function randomToken(crypto) {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchVerifiedAssets(assets, env) {
  if (!Array.isArray(assets) || assets.length === 0) return { items: [], transferables: [] };
  const items = [];
  const transferables = [];
  for (const asset of assets) {
    if (!asset || typeof asset.url !== "string" || typeof asset.sri !== "string" || !/^sha384-[A-Za-z0-9+/]+={0,2}$/.test(asset.sri)) {
      throw new BridgeError("asset requires url and sha384 sri", "sri_missing");
    }
    const res = await env.fetch(asset.url);
    if (!res.ok) throw new BridgeError(`asset fetch failed: ${res.status}`, "fetch_failed");
    const buffer = typeof res.arrayBuffer === "function"
      ? await res.arrayBuffer()
      : new TextEncoder().encode(await res.text()).buffer;
    const got = await sha384Base64(buffer, env.crypto.subtle);
    if (got !== asset.sri) throw new BridgeError(`asset SRI mismatch for ${asset.name || asset.url}`, "sri_mismatch");
    items.push({ name: asset.name || asset.url, mimeType: asset.mimeType || "application/octet-stream", buffer });
    transferables.push(buffer);
  }
  return { items, transferables };
}

/**
 * Mount a community player in a sandboxed iframe and return a PlayerController proxy.
 * - Mode A (default): opaque `srcdoc` frame (`sandbox="allow-scripts"`). Host fetches SRI-verified ESM + assets and transfers via `MessagePort`.
 * - Mode B (`mountMode: "B"`): cross-site `https://<player-id>.didactum-sandbox.org` (`sandbox="allow-scripts allow-same-origin"`).
 */
export function createSandboxedPlayer(container, opts) {
  const env = opts.env || globalThis;
  const {
    pluginUrl,
    sri,
    lesson,
    host = {},
    assets = [],
    declaredVars,
    mountMode = "A",
    sandboxOrigin,
    hostOrigin,
  } = opts;
  const contractVersion = opts.contractVersion ?? opts.version ?? CONTRACT_VERSION_V1;
  const bridgeVersion = contractVersion === CONTRACT_VERSION_V2 ? BRIDGE_VERSION_V2 : BRIDGE_VERSION;
  const methods = contractVersion === CONTRACT_VERSION_V2 ? CONTROLLER_METHODS_V2 : CONTROLLER_METHODS_V1;
  const timeoutMs = opts.timeoutMs || 10000;

  if (mountMode !== "A" && mountMode !== "B") throw new BridgeError("mountMode must be A or B", "bad_options");
  if (opts.sandbox !== undefined) assertSandbox(opts.sandbox, { mode: mountMode, origin: sandboxOrigin, hostOrigin });
  if (typeof sri !== "string" || !/^sha384-[A-Za-z0-9+/]+={0,2}$/.test(sri)) throw new BridgeError("sri (sha384) is required", "sri_missing");
  if (typeof pluginUrl !== "string" || !pluginUrl) throw new BridgeError("pluginUrl required", "bad_options");

  const doc = env.document;
  const frame = doc.createElement("iframe");
  if (mountMode === "B") {
    const sbAttr = assertSandbox(SANDBOX_ATTR_MODE_B, { mode: "B", origin: sandboxOrigin, hostOrigin });
    frame.setAttribute("sandbox", sbAttr);
    frame.setAttribute("data-mount-mode", "B");
  } else {
    frame.setAttribute("sandbox", SANDBOX_ATTR);
    assertSandbox(frame.getAttribute("sandbox"));
    frame.setAttribute("data-mount-mode", "A");
  }
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");
  frame.setAttribute("title", "Community lesson player");

  const token = randomToken(env.crypto);
  const emitter = createEmitter();
  const pending = new Map();
  let nextId = 1, port = null, destroyed = false, helloSeen = false;
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});
  const fail = (err) => { rejectReady(err); emitter.emit("error", { message: err.message, code: err.code }); };

  const postToPlayer = (m) => port.postMessage({ v: bridgeVersion, token, ...m });
  const call = (method, params = []) => {
    if (destroyed) return Promise.reject(new BridgeError("destroyed", "destroyed"));
    if (!port) return Promise.reject(new BridgeError("player not mounted", "not_ready"));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new BridgeError(`${method} timed out`, "timeout")); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      postToPlayer({ kind: "req", id, method, params });
    });
  };

  async function onPortMessage(e) {
    let m;
    try {
      m = validateMessage(e.data, { token, direction: "toHost", version: bridgeVersion, declaredVars });
    } catch (err) {
      return; /* dropped, never trusted */
    }
    if (m.kind === "res") {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      m.ok ? p.resolve(m.result) : p.reject(new BridgeError(String(m.error), "remote_error"));
    } else if (m.kind === "evt") {
      if (m.event === "ready") resolveReady();
      if (m.event === "error") rejectReady(new BridgeError(String((m.payload || {}).message), "plugin_error"));
      emitter.emit(m.event, m.payload);
    } else if (m.kind === "req") {
      const [svc, fn] = m.method.slice(5).split(".");
      try {
        if (!host[svc] || typeof host[svc][fn] !== "function") throw new Error("host service unavailable");
        const result = await host[svc][fn](...(m.params || []));
        postToPlayer({ kind: "res", id: m.id, ok: true, result: JSON.parse(JSON.stringify(result ?? null)) });
      } catch (err) { postToPlayer({ kind: "res", id: m.id, ok: false, error: String(err && err.message || err) }); }
    }
  }

  async function onWindowMessage(e) {
    // Mode A opaque-origin frames report origin "null"; Mode B frames must match their verified sandboxOrigin.
    if (e.source !== frame.contentWindow || !e.data || e.data.type !== "didactum-hello" || helloSeen) return;
    if (mountMode === "B" && e.origin !== sandboxOrigin) return;
    helloSeen = true;
    try {
      const res = await env.fetch(pluginUrl);
      if (!res.ok) throw new BridgeError(`plugin fetch failed: ${res.status}`, "fetch_failed");
      const source = await res.text();
      const got = await sha384Base64(source, env.crypto.subtle);
      if (got !== sri) throw new BridgeError("SRI mismatch: refusing to run plugin", "sri_mismatch");
      const verifiedAssets = await fetchVerifiedAssets(assets, env);
      const moduleUrl = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`;
      const ch = new env.MessageChannel();
      port = ch.port1; port.onmessage = onPortMessage;
      const targetOrigin = mountMode === "B" ? sandboxOrigin : "*";
      frame.contentWindow.postMessage(
        {
          type: "didactum-init",
          bridgeVersion,
          token,
          moduleUrl,
          lesson,
          capabilities: detectCapabilities(host, { version: contractVersion }),
          assets: verifiedAssets.items,
        },
        targetOrigin,
        [ch.port2, ...verifiedAssets.transferables],
      );
    } catch (err) { fail(err instanceof BridgeError ? err : new BridgeError(String(err.message || err))); }
  }

  const controller = {
    contractVersion,
    mountMode,
    on: (ev, fn) => emitter.on(ev, fn),
  };
  for (const method of methods) {
    if (method === "on") continue;
    controller[method] = (...args) => {
      if (method === "interrupt" && contractVersion === CONTRACT_VERSION_V2) {
        argCheck.interruptV2(args[0]);
      } else if (method !== "mount" && method !== "destroy" && argCheck[method]) {
        argCheck[method](...args);
      }
      if (method === "mount") return ready;
      if (method === "destroy") return destroy();
      return call(method, args);
    };
  }
  async function destroy() {
    if (destroyed) return; destroyed = true; clearTimeout(startTimer);
    env.removeEventListener("message", onWindowMessage);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError("destroyed", "destroyed")); }
    pending.clear();
    if (port) port.close();
    emitter.clear();
    if (frame.parentNode) frame.parentNode.removeChild(frame);
  }

  env.addEventListener("message", onWindowMessage);
  if (mountMode === "B") {
    frame.setAttribute("src", `${sandboxOrigin}/sandbox-bootstrap.html?v=${bridgeVersion}`);
  } else {
    frame.setAttribute("srcdoc", `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script type="module">${BOOTSTRAP_SRC.replace(/<\/script/gi, "<\\/script")}<\/script>`);
  }
  container.appendChild(frame);
  const startTimer = setTimeout(() => { if (!helloSeen) fail(new BridgeError("player frame did not start", "timeout")); }, timeoutMs);
  ready.finally(() => clearTimeout(startTimer)).catch(() => {});
  controller.frame = frame;
  return controller;
}

export function createSandboxedPlayerV2(container, opts) {
  return createSandboxedPlayer(container, { ...opts, contractVersion: CONTRACT_VERSION_V2 });
}
