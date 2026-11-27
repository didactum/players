// minimal-slides: complete PlayerPlugin v2 starter. One slide per beat, captions, host sequencer, layout & TTS.
export function createPlayer(container, { lesson, host = {}, capabilities = {} }) {
  const doc = container.ownerDocument || document;
  const chapters = lesson.chapters || lesson.acts || [];
  let beats = chapters.flatMap((c) => (c.beats || []).map((b) => ({ ...b, chapterTitle: c.title, chapterId: c.id, origin: b.origin || "score" })));
  const listeners = {};
  const emit = (e, p) => (listeners[e] || []).forEach((fn) => { try { fn(p); } catch (_) {} });
  let root, title, body, caption, index = 0, offsetMs = 0, seed = 0, state = "idle", timer = null;
  let rate = 1, captions = true, theme = "chalk", tts = null;
  let layout = { orientation: "landscape", teacher_tile_mode: "none", occluded: false };

  const resolveIndex = (beatIdOrIndex) => {
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

  const show = (i, opts = {}) => {
    index = Math.max(0, Math.min(i, Math.max(0, beats.length - 1)));
    offsetMs = Number.isFinite(opts.offsetMs) && opts.offsetMs >= 0 ? opts.offsetMs : 0;
    seed = opts.seed !== undefined ? opts.seed : 0;
    const b = beats[index];
    if (!b) return;
    title.textContent = b.chapterTitle || b.title || "";
    body.textContent = (b.visuals || []).map((v) => v.type).join(" · ");
    caption.textContent = captions ? (b.narration?.text || "") : "";
    if (root) {
      root.setAttribute("data-beat-id", b.id);
      root.setAttribute("data-beat-index", String(index));
      root.setAttribute("data-offset-ms", String(offsetMs));
    }
    emit("beatchange", { index, beatId: b.id, chapterId: b.chapterId, origin: b.origin, offsetMs });
    if (b.checkin) emit("checkin", { beatId: b.id, prompt: b.checkin.prompt, choices: b.checkin.choices });
  };

  const wait = (b) => Math.max(1200, ((b.narration?.text || "").split(/\s+/).length * 400) / rate);
  const next = () => {
    if (state !== "playing") return;
    const b = beats[index];
    if (!b) return;
    if (capabilities.tts && host.tts) { Promise.resolve(host.tts.synthesizeStream(b.narration?.text || "", { rate })).then((s) => { tts = s; }).catch(() => {}); }
    timer = setTimeout(() => {
      if (index >= beats.length - 1) { state = "ended"; emit("statechange", { state }); emit("complete", {}); return; }
      show(index + 1); next();
    }, wait(b));
  };
  const setState = (s) => { state = s; emit("statechange", { state }); };

  return {
    contractVersion: 2,
    async mount() {
      root = doc.createElement("div"); title = doc.createElement("h2"); body = doc.createElement("div"); caption = doc.createElement("p");
      root.setAttribute("data-theme", theme);
      root.appendChild(title); root.appendChild(body); root.appendChild(caption); container.appendChild(root);
      show(0); emit("ready", {});
    },
    play() { if (state === "playing") return; setState("playing"); next(); },
    pause() { clearTimeout(timer); if (tts && tts.abort) tts.abort(); setState("paused"); },
    seekBeat(beatIdOrIndex, opts = {}) { clearTimeout(timer); show(resolveIndex(beatIdOrIndex), opts); if (state === "playing") next(); },
    seekTime(ms) {
      let acc = 0; let i = 0;
      for (; i < beats.length - 1; i++) { acc += wait(beats[i]); if (acc > ms) break; }
      this.seekBeat(i, { offsetMs: Math.max(0, ms - acc) }); emit("timeupdate", { ms });
    },
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
    setLayout(nextLayout) {
      layout = { ...layout, ...nextLayout };
      if (root) {
        root.setAttribute("data-orientation", layout.orientation || "landscape");
        root.setAttribute("data-teacher-tile-mode", layout.teacher_tile_mode);
        root.setAttribute("data-occluded", String(Boolean(layout.occluded)));
      }
    },
    setRate(r) { rate = r; }, setVolume() {}, setMuted() {},
    setCaptions(on) { captions = on; if (caption && beats[index]) caption.textContent = on ? (beats[index].narration?.text || "") : ""; },
    setTheme(t) { theme = t; if (root) root.setAttribute("data-theme", t); },
    async interrupt(payload) {
      this.pause();
      const reason = payload && typeof payload === "object" ? payload.reason : "barge_in";
      if (root) root.setAttribute("data-interrupt-reason", reason || "barge_in");
    },
    getSceneState() {
      const b = beats[index];
      return {
        beatId: b?.id || null,
        index,
        offsetMs,
        seed,
        titleText: title ? title.textContent : "",
        bodyText: body ? body.textContent : "",
        captionText: caption ? caption.textContent : "",
        theme,
        layout: { ...layout },
        beatCount: beats.length,
      };
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => { listeners[event] = listeners[event].filter((f) => f !== fn); }; },
    destroy() { clearTimeout(timer); if (tts && tts.abort) tts.abort(); Object.keys(listeners).forEach((k) => delete listeners[k]); if (root && root.parentNode) root.parentNode.removeChild(root); },
  };
}
