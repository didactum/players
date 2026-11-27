// PlayerPlugin v2 contract (see schemas/player-plugin.v2.md) with v1 backwards compatibility. Browser ESM, no dependencies.
// A player plugin module exports `createPlayer(container, { lesson, host, capabilities, assets }) -> PlayerController`.

export const CONTRACT_VERSION = 2;
export const CONTRACT_VERSION_V1 = 1;
export const CONTRACT_VERSION_V2 = 2;

export const CONTROLLER_METHODS_V1 = Object.freeze([
  "mount", "play", "pause", "seekBeat", "seekTime", "setRate", "setVolume", "setMuted",
  "setCaptions", "setTheme", "interrupt", "on", "destroy",
]);

export const CONTROLLER_METHODS_V2 = Object.freeze([
  ...CONTROLLER_METHODS_V1,
  "appendBeats",
  "setLayout",
]);

export const CONTROLLER_METHODS = CONTROLLER_METHODS_V2;

export const EVENTS_V1 = Object.freeze([
  "ready", "statechange", "timeupdate", "beatchange", "buffering", "checkin", "error", "complete",
]);

export const EVENTS_V2 = Object.freeze([
  ...EVENTS_V1,
  "statechange_var",
  "diagnostic",
]);

export const EVENTS = EVENTS_V2;

export const THEMES = Object.freeze(["chalk", "white"]);
export const TEACHER_TILE_MODES = Object.freeze(["none", "subtitle_dock", "side_lectern", "pip"]);
export const ORIENTATIONS = Object.freeze(["portrait", "landscape"]);
export const BEAT_ORIGINS = Object.freeze(["score", "host"]);
export const INTERRUPT_REASONS = Object.freeze([
  "barge_in", "student_speech", "student_text", "pause", "seek", "layout_change", "host_abort",
]);

// HostServices: telemetry.reportPlayback is deleted in v2 (telemetry is strictly host-authoritative).
export const HOST_SERVICES_V1 = Object.freeze({
  tts: ["synthesizeStream"],
  realtime: ["connect"],
  tutor: ["ask"],
  telemetry: ["reportPlayback"],
});

export const HOST_SERVICES_V2 = Object.freeze({
  tts: ["synthesizeStream"],
  realtime: ["connect"],
  tutor: ["ask"],
});

export const HOST_SERVICES = HOST_SERVICES_V2;

export class ContractError extends Error {
  constructor(message) { super(message); this.name = "ContractError"; }
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function validateRect(rect, label) {
  if (!isPlainObject(rect)) throw new ContractError(`${label}: must be an object`);
  for (const k of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(rect[k])) throw new ContractError(`${label}.${k}: finite number required`);
  }
  if (rect.width < 0 || rect.height < 0) throw new ContractError(`${label}: width and height must be >= 0`);
  return rect;
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

export function assertController(ctrl, opts = {}) {
  if (!ctrl || typeof ctrl !== "object") throw new ContractError("createPlayer must return a PlayerController");
  const version = opts.version ?? (ctrl.contractVersion === CONTRACT_VERSION_V2 ? CONTRACT_VERSION_V2 : CONTRACT_VERSION_V1);
  const required = version === CONTRACT_VERSION_V2 ? CONTROLLER_METHODS_V2 : CONTROLLER_METHODS_V1;
  const missing = required.filter((m) => typeof ctrl[m] !== "function");
  if (missing.length) throw new ContractError(`PlayerController missing: ${missing.join(", ")}`);
  return ctrl;
}

export function assertControllerV2(ctrl) {
  return assertController(ctrl, { version: CONTRACT_VERSION_V2 });
}

export function assertPluginModule(mod) {
  if (!mod || typeof mod.createPlayer !== "function") throw new ContractError("plugin must export createPlayer()");
  return mod;
}

/** Which optional host services are actually present (shape-checked), for `capabilities`. */
export function detectCapabilities(host, opts = {}) {
  const version = opts.version ?? CONTRACT_VERSION_V1;
  const services = version === CONTRACT_VERSION_V2 ? HOST_SERVICES_V2 : HOST_SERVICES_V1;
  const caps = {};
  for (const [svc, fns] of Object.entries(services)) {
    caps[svc] = !!host && !!host[svc] && fns.every((f) => typeof host[svc][f] === "function");
  }
  return caps;
}

export function detectCapabilitiesV2(host) {
  return detectCapabilities(host, { version: CONTRACT_VERSION_V2 });
}

const DISALLOWED_INTERRUPT_KEYS = new Set([
  "text", "transcript", "rawInput", "studentInput", "mic", "camera", "audio", "audioStream", "videoStream", "mediaStream",
]);

const DISALLOWED_DIAGNOSTIC_KEYS = new Set([
  "completed", "complete", "progress", "percent", "durationMs", "playedMs", "attestation", "mastery", "score", "passed",
]);

/** Validates typed, bounded declared state variable updates (`statechange_var`). */
export function validateStateVar(payload, declaredVars) {
  if (!isPlainObject(payload)) throw new ContractError("statechange_var: payload must be an object");
  const { var: varName, value } = payload;
  if (typeof varName !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(varName)) {
    throw new ContractError("statechange_var: invalid var name");
  }
  if (!("value" in payload) || value === undefined || value === null) {
    throw new ContractError("statechange_var: value required");
  }
  if (typeof value === "object") {
    throw new ContractError("statechange_var: value must be primitive (number|boolean|enum token)");
  }
  if (declaredVars) {
    const spec = declaredVars[varName];
    if (!spec) throw new ContractError(`statechange_var: undeclared var "${varName}"`);
    if (spec.type === "number" || spec.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ContractError(`statechange_var: ${varName} must be a finite number`);
      if (spec.type === "integer" && !Number.isInteger(value)) throw new ContractError(`statechange_var: ${varName} must be an integer`);
      if (spec.min !== undefined && value < spec.min) throw new ContractError(`statechange_var: ${varName} below min ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) throw new ContractError(`statechange_var: ${varName} above max ${spec.max}`);
    } else if (spec.type === "boolean") {
      if (typeof value !== "boolean") throw new ContractError(`statechange_var: ${varName} must be boolean`);
    } else if (spec.type === "enum") {
      if (!Array.isArray(spec.values) || !spec.values.includes(value)) {
        throw new ContractError(`statechange_var: ${varName} not in declared enum`);
      }
    } else {
      throw new ContractError(`statechange_var: unsupported declared type ${spec.type}`);
    }
    return payload;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractError("statechange_var: non-finite number");
  } else if (typeof value === "string") {
    // Strictly reject free-text strings; only short compact enum tokens allowed without schema.
    if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(value)) {
      throw new ContractError("statechange_var: free-text strings are forbidden");
    }
  } else if (typeof value !== "boolean") {
    throw new ContractError("statechange_var: unsupported value type");
  }
  return payload;
}

/** Validates coarse enum/int diagnostics (`diagnostic` event) — never playback attestations. */
export function validateDiagnostic(payload) {
  if (!isPlainObject(payload)) throw new ContractError("diagnostic: payload must be an object");
  if (typeof payload.code !== "string" || !/^[a-z0-9_.-]{1,48}$/i.test(payload.code)) {
    throw new ContractError("diagnostic: coarse enum code required");
  }
  for (const k of Object.keys(payload)) {
    if (DISALLOWED_DIAGNOSTIC_KEYS.has(k)) {
      throw new ContractError(`diagnostic: attestation field "${k}" forbidden`);
    }
  }
  if (payload.level !== undefined && !["info", "warn", "error"].includes(payload.level)) {
    throw new ContractError("diagnostic: level must be info|warn|error");
  }
  if (payload.count !== undefined && (!Number.isInteger(payload.count) || payload.count < 0)) {
    throw new ContractError("diagnostic: count must be non-negative integer");
  }
  if (payload.value !== undefined && !Number.isInteger(payload.value)) {
    throw new ContractError("diagnostic: value must be an integer");
  }
  return payload;
}

/** Validates args at the PlayerController boundary; returns the normalised value or throws ContractError. */
export const argCheck = Object.freeze({
  seekBeat(beatId, opts) {
    const validStr = typeof beatId === "string" && beatId.trim().length > 0;
    const validInt = Number.isInteger(beatId) && beatId >= 0;
    if (!validStr && !validInt) throw new ContractError("seekBeat: non-empty string beatId or non-negative integer");
    if (opts !== undefined) {
      if (!isPlainObject(opts)) throw new ContractError("seekBeat: opts must be an object");
      if (opts.offsetMs !== undefined && (!Number.isFinite(opts.offsetMs) || opts.offsetMs < 0)) {
        throw new ContractError("seekBeat: opts.offsetMs must be non-negative ms");
      }
      if (opts.seed !== undefined && typeof opts.seed !== "number" && typeof opts.seed !== "string") {
        throw new ContractError("seekBeat: opts.seed must be number or string");
      }
      if (typeof opts.seed === "number" && !Number.isFinite(opts.seed)) {
        throw new ContractError("seekBeat: opts.seed must be finite");
      }
    }
    return beatId;
  },
  seekTime(ms) { if (!Number.isFinite(ms) || ms < 0) throw new ContractError("seekTime: non-negative ms"); return ms; },
  appendBeats(beats) {
    if (!Array.isArray(beats)) throw new ContractError("appendBeats: beats array required");
    return beats.map((b, idx) => {
      if (!isPlainObject(b) || typeof b.id !== "string" || !b.id.trim()) {
        throw new ContractError(`appendBeats[${idx}]: beat object with non-empty string id required`);
      }
      if (b.origin !== undefined && !BEAT_ORIGINS.includes(b.origin)) {
        throw new ContractError(`appendBeats[${idx}]: origin must be score|host`);
      }
      return { ...b, origin: b.origin || "host" };
    });
  },
  setLayout(layout) {
    if (!isPlainObject(layout)) throw new ContractError("setLayout: layout object required");
    if (!TEACHER_TILE_MODES.includes(layout.teacher_tile_mode)) {
      throw new ContractError(`setLayout: teacher_tile_mode must be ${TEACHER_TILE_MODES.join("|")}`);
    }
    if (layout.orientation !== undefined && !ORIENTATIONS.includes(layout.orientation)) {
      throw new ContractError(`setLayout: orientation must be ${ORIENTATIONS.join("|")}`);
    }
    if (layout.occluded !== undefined && typeof layout.occluded !== "boolean") {
      throw new ContractError("setLayout: occluded must be boolean");
    }
    if (layout.rect !== undefined) validateRect(layout.rect, "setLayout.rect");
    if (layout.safe_rect !== undefined) validateRect(layout.safe_rect, "setLayout.safe_rect");
    return layout;
  },
  setRate(r) { if (!Number.isFinite(r) || r < 0.25 || r > 4) throw new ContractError("setRate: 0.25..4"); return r; },
  setVolume(v) { if (!Number.isFinite(v) || v < 0 || v > 1) throw new ContractError("setVolume: 0..1"); return v; },
  setMuted(b) { if (typeof b !== "boolean") throw new ContractError("setMuted: boolean"); return b; },
  setCaptions(b) { if (typeof b !== "boolean") throw new ContractError("setCaptions: boolean"); return b; },
  setTheme(t) { if (!THEMES.includes(t)) throw new ContractError("setTheme: chalk|white"); return t; },
  interrupt(s, opts) {
    if (opts && opts.version === CONTRACT_VERSION_V2) return argCheck.interruptV2(s);
    if (typeof s !== "string" && (!s || typeof s !== "object")) throw new ContractError("interrupt: string|object");
    return s;
  },
  interruptV2(payload) {
    if (!isPlainObject(payload)) throw new ContractError("interrupt: v2 requires structured { reason } object");
    if (typeof payload.reason !== "string" || !/^[a-z0-9_:-]{1,64}$/i.test(payload.reason)) {
      throw new ContractError("interrupt: structured reason code required");
    }
    for (const k of Object.keys(payload)) {
      if (DISALLOWED_INTERRUPT_KEYS.has(k)) {
        throw new ContractError(`interrupt: raw student/media field "${k}" is forbidden`);
      }
    }
    return payload;
  },
  stateVar: validateStateVar,
  diagnostic: validateDiagnostic,
});

function defaultSnapshotDom(node) {
  if (!node) return null;
  if (typeof node === "string") return node;
  return {
    tag: node.tag || node.tagName || null,
    attrs: node.attrs || {},
    text: node.textContent ?? "",
    children: Array.isArray(node.children) ? node.children.map(defaultSnapshotDom) : [],
  };
}

/**
 * Reusable beat-idempotence test assertion (`1→2→3` produces identical scene state to `3→1→3`).
 */
export async function assertSeekIdempotent(ctrl, beatIds, getSnapshot) {
  if (!Array.isArray(beatIds) || beatIds.length < 3) {
    throw new ContractError("assertSeekIdempotent: at least 3 beatIds required");
  }
  const [b1, b2, b3] = beatIds;
  let lastBeatEvent = null;
  const off = ctrl.on("beatchange", (ev) => { lastBeatEvent = ev; });

  const capture = async (seq) => {
    for (const id of seq) {
      await ctrl.seekBeat(id);
    }
    const state = typeof getSnapshot === "function"
      ? await getSnapshot(ctrl)
      : (typeof ctrl.getSceneState === "function"
        ? ctrl.getSceneState()
        : defaultSnapshotDom(ctrl.root || null));
    return { beatEvent: lastBeatEvent, state };
  };

  try {
    const forward = await capture([b1, b2, b3]);
    const backward = await capture([b3, b1, b3]);
    if (JSON.stringify(forward) !== JSON.stringify(backward)) {
      throw new ContractError(
        `seekBeat is not idempotent: 1->2->3 (${JSON.stringify(forward)}) !== 3->1->3 (${JSON.stringify(backward)})`
      );
    }
    return { forward, backward };
  } finally {
    if (typeof off === "function") off();
  }
}

/** A host with no services; players must degrade gracefully (captions-only, silent). */
export function createNullHost() { return {}; }
