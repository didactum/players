// griffin-video-stub: skeleton for a real-time video teacher (e.g. Tavus Griffin) over host.realtime.connect.
// Inside the Tier-B sandbox no MediaStream can cross the bridge, so this stub is data/captions-only there;
// a Tier-A host build would attach `session.remoteMediaStream` to a <video>. interrupt() is the barge-in path.
export function createPlayer(container, { lesson, host = {}, capabilities = {} }) {
  const doc = container.ownerDocument || document;
  const beats = (lesson.chapters || lesson.acts).flatMap((c) => c.beats);
  const listeners = {};
  const emit = (e, p) => (listeners[e] || []).forEach((fn) => { try { fn(p); } catch (_) {} });
  let root, status, video = null, session = null, index = 0, state = "idle", destroyed = false;

  const connect = async () => {
    if (!capabilities.realtime || !host.realtime) { status.textContent = "Real-time teacher unavailable; showing captions."; return; }
    emit("buffering", { on: true });
    try {
      session = await host.realtime.connect({ lessonId: lesson.id, beatId: beats[index].id, mode: "teach" });
      if (destroyed) { if (session && session.close) session.close(); return; }
      if (session && session.remoteMediaStream && video) video.srcObject = session.remoteMediaStream;
      status.textContent = "Teacher connected.";
    } catch (err) {
      status.textContent = "Teacher unavailable; showing captions.";
      emit("error", { message: String((err && err.message) || err), recoverable: true });
    }
    emit("buffering", { on: false });
  };
  const sendBeat = () => { if (session && session.sendData) session.sendData({ type: "beat", beatId: beats[index].id, say: beats[index].narration.text }); };
  const show = (i) => { index = Math.max(0, Math.min(i, beats.length - 1)); status.textContent = beats[index].narration.text; emit("beatchange", { index, beatId: beats[index].id }); sendBeat(); };
  const setState = (s) => { state = s; emit("statechange", { state: s }); };

  return {
    async mount() {
      root = doc.createElement("div"); status = doc.createElement("p"); video = doc.createElement("video");
      root.appendChild(video); root.appendChild(status); container.appendChild(root);
      await connect(); show(0); emit("ready", {});
    },
    play() { setState("playing"); sendBeat(); },
    pause() { if (session && session.sendData) session.sendData({ type: "pause" }); setState("paused"); },
    seekBeat(i) { show(i); }, seekTime() {}, setRate() {}, setVolume() {}, setMuted() {}, setCaptions() {}, setTheme(t) { if (root) root.setAttribute("data-theme", t); },
    async interrupt(input) {
      if (session && session.sendData) session.sendData({ type: "barge-in", beatId: beats[index].id, input });
      else if (host.tutor && capabilities.tutor) status.textContent = String(await host.tutor.ask({ lessonId: lesson.id, beatId: beats[index].id }, input));
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => { listeners[event] = listeners[event].filter((f) => f !== fn); }; },
    destroy() { destroyed = true; if (session && session.close) session.close(); Object.keys(listeners).forEach((k) => delete listeners[k]); if (root && root.parentNode) root.parentNode.removeChild(root); },
  };
}
