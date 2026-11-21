// minimal-slides: the smallest complete PlayerPlugin v1. One slide per beat, captions, optional host TTS.
export function createPlayer(container, { lesson, host = {}, capabilities = {} }) {
  const doc = container.ownerDocument || document;
  const chapters = lesson.chapters || lesson.acts;
  const beats = chapters.flatMap((c) => c.beats.map((b) => ({ ...b, chapter: c })));
  const listeners = {};
  const emit = (e, p) => (listeners[e] || []).forEach((fn) => { try { fn(p); } catch (_) {} });
  let root, title, body, caption, index = 0, state = "idle", timer = null, rate = 1, captions = true, tts = null;

  const show = (i) => {
    index = Math.max(0, Math.min(i, beats.length - 1));
    const b = beats[index];
    title.textContent = b.chapter.title;
    body.textContent = (b.visuals || []).map((v) => v.type).join(" · ");
    caption.textContent = captions ? b.narration.text : "";
    emit("beatchange", { index, beatId: b.id, chapterId: b.chapter.id });
    if (b.checkin) emit("checkin", { beatId: b.id, prompt: b.checkin.prompt, choices: b.checkin.choices });
  };
  const wait = (b) => Math.max(1200, (b.narration.text.split(/\s+/).length * 400) / rate);
  const next = () => {
    if (state !== "playing") return;
    const b = beats[index];
    if (capabilities.tts && host.tts) { Promise.resolve(host.tts.synthesizeStream(b.narration.text, { rate })).then((s) => { tts = s; }).catch(() => {}); }
    timer = setTimeout(() => {
      if (index >= beats.length - 1) { state = "ended"; emit("statechange", { state }); emit("complete", {}); return; }
      show(index + 1); next();
    }, wait(b));
  };
  const setState = (s) => { state = s; emit("statechange", { state }); };

  return {
    async mount() {
      root = doc.createElement("div"); title = doc.createElement("h2"); body = doc.createElement("div"); caption = doc.createElement("p");
      root.appendChild(title); root.appendChild(body); root.appendChild(caption); container.appendChild(root);
      show(0); emit("ready", {});
    },
    play() { if (state === "playing") return; setState("playing"); next(); },
    pause() { clearTimeout(timer); if (tts && tts.abort) tts.abort(); setState("paused"); },
    seekBeat(i) { clearTimeout(timer); show(i); if (state === "playing") next(); },
    seekTime(ms) {
      let acc = 0; let i = 0;
      for (; i < beats.length - 1; i++) { acc += wait(beats[i]); if (acc > ms) break; }
      this.seekBeat(i); emit("timeupdate", { ms });
    },
    setRate(r) { rate = r; }, setVolume() {}, setMuted() {},
    setCaptions(on) { captions = on; if (caption) caption.textContent = on ? beats[index].narration.text : ""; },
    setTheme(t) { if (root) root.setAttribute("data-theme", t); },
    async interrupt(input) {
      this.pause();
      if (host.tutor && capabilities.tutor) {
        const a = await host.tutor.ask({ lessonId: lesson.id, beatId: beats[index].id }, input);
        caption.textContent = typeof a === "string" ? a : (a && a.text) || "";
      }
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => { listeners[event] = listeners[event].filter((f) => f !== fn); }; },
    destroy() { clearTimeout(timer); if (tts && tts.abort) tts.abort(); Object.keys(listeners).forEach((k) => delete listeners[k]); if (root && root.parentNode) root.parentNode.removeChild(root); },
  };
}
