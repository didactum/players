// PlayerPlugin v1 contract (see schemas/player-plugin.v1.md). Browser ESM, no dependencies.
// A player plugin module exports `createPlayer(container, { lesson, host, capabilities }) -> PlayerController`.

export const CONTRACT_VERSION = 1;

export const CONTROLLER_METHODS = Object.freeze([
  "mount", "play", "pause", "seekBeat", "seekTime", "setRate", "setVolume", "setMuted",
  "setCaptions", "setTheme", "interrupt", "on", "destroy",
]);

export const EVENTS = Object.freeze([
  "ready", "statechange", "timeupdate", "beatchange", "buffering", "checkin", "error", "complete",
]);

export const THEMES = Object.freeze(["chalk", "white"]);

// HostServices the host may provide; every one is optional, players must feature-detect via `capabilities`.
export const HOST_SERVICES = Object.freeze({
  tts: ["synthesizeStream"],
  realtime: ["connect"],
  tutor: ["ask"],
  telemetry: ["reportPlayback"],
});

export class ContractError extends Error {
  constructor(message) { super(message); this.name = "ContractError"; }
}

/** Minimal emitter for plugin authors; listener errors never break playback. */
export function createEmitter() {
  const map = new Map();
  return {
    on(event, fn) {
      if (!EVENTS.includes(event)) throw new ContractError(`unknown event: ${event}`);
      if (typeof fn !== "function") throw new ContractError("listener must be a function");
      if (!map.has(event)) map.set(event, new Set());
      map.get(event).add(fn);
      return () => map.get(event).delete(fn);
    },
    emit(event, payload) {
      if (!EVENTS.includes(event)) throw new ContractError(`unknown event: ${event}`);
      for (const fn of [...(map.get(event) || [])]) {
        try { fn(payload); } catch (_) { /* contained */ }
      }
    },
    clear() { map.clear(); },
  };
}

export function assertController(ctrl) {
  if (!ctrl || typeof ctrl !== "object") throw new ContractError("createPlayer must return a PlayerController");
  const missing = CONTROLLER_METHODS.filter((m) => typeof ctrl[m] !== "function");
  if (missing.length) throw new ContractError(`PlayerController missing: ${missing.join(", ")}`);
  return ctrl;
}

export function assertPluginModule(mod) {
  if (!mod || typeof mod.createPlayer !== "function") throw new ContractError("plugin must export createPlayer()");
  return mod;
}

/** Which optional host services are actually present (shape-checked), for `capabilities`. */
export function detectCapabilities(host) {
  const caps = {};
  for (const [svc, fns] of Object.entries(HOST_SERVICES)) {
    caps[svc] = !!host && !!host[svc] && fns.every((f) => typeof host[svc][f] === "function");
  }
  return caps;
}

/** Validates args at the PlayerController boundary; returns the normalised value or throws ContractError. */
export const argCheck = Object.freeze({
  seekBeat(i) { if (!Number.isInteger(i) || i < 0) throw new ContractError("seekBeat: non-negative integer"); return i; },
  seekTime(ms) { if (!Number.isFinite(ms) || ms < 0) throw new ContractError("seekTime: non-negative ms"); return ms; },
  setRate(r) { if (!Number.isFinite(r) || r < 0.25 || r > 4) throw new ContractError("setRate: 0.25..4"); return r; },
  setVolume(v) { if (!Number.isFinite(v) || v < 0 || v > 1) throw new ContractError("setVolume: 0..1"); return v; },
  setMuted(b) { if (typeof b !== "boolean") throw new ContractError("setMuted: boolean"); return b; },
  setCaptions(b) { if (typeof b !== "boolean") throw new ContractError("setCaptions: boolean"); return b; },
  setTheme(t) { if (!THEMES.includes(t)) throw new ContractError("setTheme: chalk|white"); return t; },
  interrupt(s) { if (typeof s !== "string" && (!s || typeof s !== "object")) throw new ContractError("interrupt: string|object"); return s; },
});

/** A host with no services; players must degrade gracefully (captions-only, silent). */
export function createNullHost() { return {}; }
