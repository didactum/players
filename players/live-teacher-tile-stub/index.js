// live-teacher-tile-stub: vendor-agnostic PlayerPlugin v2 starter for a live AI face+voice teacher tile.
// Runs over host.realtime.connect in Mode A (host-docked / data-only) or Tier A (MediaStream).
// Beat-idempotent seekBeat, dynamic appendBeats, host-owned setLayout, and structured interrupt({ reason }).
export function createPlayer(container, { lesson, host = {}, capabilities = {} }) {
  const doc = container.ownerDocument || document;
  const chapters = lesson.chapters || lesson.acts || [];
  let beats = chapters.flatMap((c) => (c.beats || []).map((b) => ({ ...b, chapterId: c.id, origin: b.origin || "score" })));
  const listeners = {};
  const emit = (e, p) => (listeners[e] || []).forEach((fn) => { try { fn(p); } catch (_) {} });
  let root, tile, video = null, status, session = null;
  let index = 0, offsetMs = 0, seed = 0, state = "idle", destroyed = false;
  let rate = 1, volume = 1, muted = false, captions = true, theme = "chalk";
  let layout = { orientation: "landscape", teacher_tile_mode: "side_lectern", occluded: false };

  const findBeatIndex = (beatIdOrIndex) => {
    if (typeof beatIdOrIndex === "string") {
      const idx = beats.findIndex((b) => b.id === beatIdOrIndex);
      if (idx === -1) throw new Error(`unknown beatId: ${beatIdOrIndex}`);
      return idx;
    }
    if (Number.isInteger(beatIdOrIndex) && beatIdOrIndex >= 0) {
      return Math.min(beatIdOrIndex, Math.max(0, beats.length - 1));
    }
    throw new Error("seekBeat requires string beatId or non-negative integer");
  };

  const applyLayout = (nextLayout) => {
    layout = { ...layout, ...nextLayout };
    if (!root || !tile) return;
    root.setAttribute("data-orientation", layout.orientation || "landscape");
    root.setAttribute("data-teacher-tile-mode", layout.teacher_tile_mode);
    root.setAttribute("data-occluded", String(Boolean(layout.occluded)));
    tile.setAttribute("data-tile-mode", layout.teacher_tile_mode);
    tile.style.display = layout.teacher_tile_mode === "none" ? "none" : "block";
  };

  const connect = async () => {
    if (!capabilities.realtime || !host.realtime) {
      status.textContent = "Live teacher tile unavailable; showing captions.";
      emit("diagnostic", { code: "realtime_unavailable", level: "info" });
      return;
    }
    emit("buffering", { on: true });
    try {
      session = await host.realtime.connect({ lessonId: lesson.id, beatId: beats[index]?.id, mode: "teach" });
      if (destroyed) { if (session && session.close) session.close(); return; }
      if (session && session.remoteMediaStream && video) video.srcObject = session.remoteMediaStream;
      status.textContent = "Live teacher connected.";
    } catch (_) {
      status.textContent = "Live teacher unavailable; showing captions.";
      emit("diagnostic", { code: "realtime_connect_fallback", level: "warn" });
    }
    emit("buffering", { on: false });
  };

  const sendBeat = () => {
    const b = beats[index];
    if (b && session && session.sendData) {
      session.sendData({ type: "beat", beatId: b.id, offsetMs, seed, say: b.narration?.text || "" });
    }
  };

  const renderBeat = (i, opts = {}) => {
    index = Math.max(0, Math.min(i, Math.max(0, beats.length - 1)));
    offsetMs = Number.isFinite(opts.offsetMs) && opts.offsetMs >= 0 ? opts.offsetMs : 0;
    seed = opts.seed !== undefined ? opts.seed : 0;
    const b = beats[index];
    if (!b) return;
    if (root) {
      root.setAttribute("data-beat-id", b.id);
      root.setAttribute("data-beat-index", String(index));
      root.setAttribute("data-offset-ms", String(offsetMs));
    }
    if (status) status.textContent = captions ? (b.narration?.text || "") : "";
    emit("beatchange", { index, beatId: b.id, chapterId: b.chapterId, origin: b.origin, offsetMs });
    if (b.checkin) emit("checkin", { beatId: b.id, prompt: b.checkin.prompt, choices: b.checkin.choices });
    sendBeat();
  };

  const setState = (s) => { state = s; emit("statechange", { state: s }); };

  return {
    contractVersion: 2,
    async mount() {
      root = doc.createElement("div");
      root.setAttribute("data-player", "live-teacher-tile-stub");
      root.setAttribute("data-theme", theme);
      tile = doc.createElement("div");
      tile.setAttribute("data-teacher-tile", "true");
      video = doc.createElement("video");
      status = doc.createElement("p");
      tile.appendChild(video);
      root.appendChild(tile);
      root.appendChild(status);
      container.appendChild(root);
      applyLayout(layout);
      await connect();
      renderBeat(0);
      emit("ready", {});
    },
    play() { setState("playing"); sendBeat(); },
    pause() { if (session && session.sendData) session.sendData({ type: "pause" }); setState("paused"); },
    seekBeat(beatIdOrIndex, opts = {}) { renderBeat(findBeatIndex(beatIdOrIndex), opts); },
    seekTime(ms) { offsetMs = Math.max(0, Number(ms) || 0); emit("timeupdate", { ms: offsetMs }); },
    appendBeats(newBeats) {
      for (const nb of newBeats) {
        if (!nb || typeof nb.id !== "string" || !nb.id.trim()) throw new Error("beat id required");
        const entry = { ...nb, origin: nb.origin || "host" };
        const existing = beats.findIndex((b) => b.id === entry.id);
        if (existing >= 0) beats[existing] = entry;
        else beats.push(entry);
      }
      return beats.length;
    },
    setLayout(nextLayout) { applyLayout(nextLayout); },
    setRate(r) { rate = r; },
    setVolume(v) { volume = v; },
    setMuted(m) { muted = m; },
    setCaptions(on) { captions = on; if (status && beats[index]) status.textContent = on ? (beats[index].narration?.text || "") : ""; },
    setTheme(t) { theme = t; if (root) root.setAttribute("data-theme", t); },
    async interrupt(payload) {
      const reason = payload && typeof payload === "object" ? payload.reason : "barge_in";
      this.pause();
      if (session && session.sendData) session.sendData({ type: "barge-in", beatId: beats[index]?.id, reason });
    },
    getSceneState() {
      const b = beats[index];
      return {
        beatId: b?.id || null,
        index,
        offsetMs,
        seed,
        captionText: status ? status.textContent : "",
        theme,
        layout: { ...layout },
        beatCount: beats.length,
      };
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => { listeners[event] = listeners[event].filter((f) => f !== fn); }; },
    destroy() {
      destroyed = true;
      if (session && session.close) session.close();
      Object.keys(listeners).forEach((k) => delete listeners[k]);
      if (root && root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
