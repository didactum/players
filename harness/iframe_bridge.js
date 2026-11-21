// Tier-B sandbox: community players run in <iframe sandbox="allow-scripts"> (opaque origin, NEVER allow-same-origin)
// and talk to the host only through a MessageChannel RPC bridge with a handshake token.
import { CONTROLLER_METHODS, EVENTS, HOST_SERVICES, ContractError, createEmitter, argCheck, detectCapabilities } from "./plugin_contract.js";

export const SANDBOX_ATTR = "allow-scripts";
export const BRIDGE_VERSION = 1;
const MAX_MESSAGE_BYTES = 256 * 1024;
const HOST_CALLS = new Set(Object.entries(HOST_SERVICES).flatMap(([s, fns]) => fns.map((f) => `${s}.${f}`)));

export class BridgeError extends Error {
  constructor(message, code = "bridge_error") { super(message); this.name = "BridgeError"; this.code = code; }
}

/** Throws unless the sandbox value is exactly `allow-scripts`. */
export function assertSandbox(value) {
  const tokens = String(value || "").split(/\s+/).filter(Boolean);
  if (tokens.includes("allow-same-origin")) throw new BridgeError("allow-same-origin is forbidden for community players", "sandbox_escape");
  if (tokens.length !== 1 || tokens[0] !== SANDBOX_ATTR) throw new BridgeError(`sandbox must be exactly "${SANDBOX_ATTR}"`, "sandbox_escape");
  return SANDBOX_ATTR;
}

/**
 * Strict envelope validation for messages arriving on the bridge port.
 *   host -> player:  {v, token, kind:"req", id, method, params}
 *   player -> host:  {v, token, kind:"res", id, ok, result|error}  |  {kind:"evt", event, payload}
 *                    {v, token, kind:"req", id, method:"host.<svc>.<fn>", params}
 * `direction` is "toHost" (what the host accepts) or "toPlayer".
 */
export function validateMessage(msg, { token, direction }) {
  const bad = (why) => { throw new BridgeError(why, "bad_message"); };
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) bad("message must be an object");
  if (msg.v !== BRIDGE_VERSION) bad("unsupported bridge version");
  if (typeof msg.token !== "string" || msg.token !== token) throw new BridgeError("bad token", "unauthorized");
  let size = 0;
  try { size = JSON.stringify(msg).length; } catch (_) { bad("message not serialisable"); }
  if (size > MAX_MESSAGE_BYTES) bad("message too large");
  switch (msg.kind) {
    case "req":
      if (!Number.isInteger(msg.id) || msg.id < 1) bad("req needs integer id");
      if (typeof msg.method !== "string") bad("req needs method");
      if (direction === "toHost" ? !(msg.method.startsWith("host.") && HOST_CALLS.has(msg.method.slice(5))) : !CONTROLLER_METHODS.includes(msg.method)) {
        throw new BridgeError(`method not allowed: ${msg.method}`, "unauthorized");
      }
      if (msg.params !== undefined && !Array.isArray(msg.params)) bad("params must be an array");
      break;
    case "res":
      if (!Number.isInteger(msg.id) || typeof msg.ok !== "boolean") bad("res needs id and ok");
      break;
    case "evt":
      if (direction !== "toHost") bad("events only flow to the host");
      if (!EVENTS.includes(msg.event)) throw new BridgeError(`unknown event: ${msg.event}`, "bad_message");
      break;
    default: bad("unknown kind");
  }
  return msg;
}

export async function sha384Base64(text, subtle) {
  const buf = await subtle.digest("SHA-384", new TextEncoder().encode(text));
  let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return `sha384-${btoa(s)}`;
}

// Runs INSIDE the opaque-origin iframe: waits for the host's port, proxies host services over RPC, mounts the plugin.
export const BOOTSTRAP_SRC = `
const BV = ${BRIDGE_VERSION};
let port, token, nextId = 1; const pending = new Map();
function send(m) { port.postMessage({ v: BV, token, ...m }); }
function callHost(method, args) {
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ kind: "req", id, method: "host." + method, params: args }); });
}
const host = { tts: { synthesizeStream: (...a) => callHost("tts.synthesizeStream", a) },
  realtime: { connect: (...a) => callHost("realtime.connect", a) },
  tutor: { ask: (...a) => callHost("tutor.ask", a) },
  telemetry: { reportPlayback: (...a) => callHost("telemetry.reportPlayback", a) } };
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
  port = e.ports[0]; token = e.data.token; port.onmessage = onMsg;
  try {
    const mod = await import(e.data.moduleUrl);
    const container = document.getElementById("root");
    ctrl = mod.createPlayer(container, { lesson: e.data.lesson, host, capabilities: e.data.capabilities });
    for (const ev of ${JSON.stringify(EVENTS)}) if (ev !== "ready") ctrl.on(ev, (payload) => send({ kind: "evt", event: ev, payload }));
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

/**
 * Mount a community player in a sandboxed iframe and return a PlayerController proxy.
 * The plugin source is fetched by the HOST, SRI-verified, then handed to the opaque-origin frame as a blob/data URL,
 * so the frame itself needs no network and no origin.
 */
export function createSandboxedPlayer(container, opts) {
  const env = opts.env || globalThis;
  const { pluginUrl, sri, lesson, host = {} } = opts;
  const timeoutMs = opts.timeoutMs || 10000;
  if (opts.sandbox !== undefined) assertSandbox(opts.sandbox);
  if (typeof sri !== "string" || !/^sha384-[A-Za-z0-9+/]+={0,2}$/.test(sri)) throw new BridgeError("sri (sha384) is required", "sri_missing");
  if (typeof pluginUrl !== "string" || !pluginUrl) throw new BridgeError("pluginUrl required", "bad_options");

  const doc = env.document;
  const frame = doc.createElement("iframe");
  frame.setAttribute("sandbox", SANDBOX_ATTR);
  assertSandbox(frame.getAttribute("sandbox"));
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

  const postToPlayer = (m) => port.postMessage({ v: BRIDGE_VERSION, token, ...m });
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
    try { m = validateMessage(e.data, { token, direction: "toHost" }); } catch (err) { return; /* dropped, never trusted */ }
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
    // Opaque-origin frames report origin "null"; the only trustworthy identity check is the source window.
    if (e.source !== frame.contentWindow || !e.data || e.data.type !== "didactum-hello" || helloSeen) return;
    helloSeen = true;
    try {
      const res = await env.fetch(pluginUrl);
      if (!res.ok) throw new BridgeError(`plugin fetch failed: ${res.status}`, "fetch_failed");
      const source = await res.text();
      const got = await sha384Base64(source, env.crypto.subtle);
      if (got !== sri) throw new BridgeError("SRI mismatch: refusing to run plugin", "sri_mismatch");
      const moduleUrl = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`;
      const ch = new env.MessageChannel();
      port = ch.port1; port.onmessage = onPortMessage;
      frame.contentWindow.postMessage({ type: "didactum-init", token, moduleUrl, lesson, capabilities: detectCapabilities(host) }, "*", [ch.port2]);
    } catch (err) { fail(err instanceof BridgeError ? err : new BridgeError(String(err.message || err))); }
  }

  const controller = { on: (ev, fn) => emitter.on(ev, fn) };
  for (const method of CONTROLLER_METHODS) {
    if (method === "on") continue;
    controller[method] = (...args) => {
      if (method !== "mount" && method !== "destroy" && argCheck[method]) argCheck[method](...args);
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
  frame.setAttribute("srcdoc", `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script type="module">${BOOTSTRAP_SRC.replace(/<\/script/gi, "<\\/script")}<\/script>`);
  container.appendChild(frame);
  const startTimer = setTimeout(() => { if (!helloSeen) fail(new BridgeError("player frame did not start", "timeout")); }, timeoutMs);
  ready.finally(() => clearTimeout(startTimer)).catch(() => {});
  controller.frame = frame;
  return controller;
}
