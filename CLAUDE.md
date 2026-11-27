# AGENTS.md — building a Didactum player

You are building a **player**: a teacher that consumes any LessonPackage and presents it (chalkboard, comic
storyboard, 3D lab, on-device voice narrator, or live AI teacher tile). You never edit lessons; they live in
[didactum/lessons](https://github.com/didactum/lessons). Read `spec/player-plugin.v2.md` first, then copy
`players/minimal-slides/index.js` or `players/live-teacher-tile-stub/index.js` (live AI teacher tile).

## The loop

1. `players/<your-id>/index.js` exporting `createPlayer(container, { lesson, host, capabilities, assets })` → `PlayerController`
   with every v2 method (`mount play pause seekBeat seekTime appendBeats setLayout setRate setVolume setMuted setCaptions setTheme interrupt on destroy`)
   and the canonical events (`ready statechange timeupdate beatchange buffering checkin error complete statechange_var diagnostic`).
2. Add an entry to `players-registry.json` (`tier: "B"`), then `npm run sri` to pin the `sha384`.
3. `npm test` until `OK`, then `npm run preview` and try your player in the real sandbox.
4. Open a PR. CI re-checks SRI, forbidden APIs, seek idempotence, and the v2 contract.

## Hard rules (CI enforces them)

- **One self-contained file** per player (SRI pins its bytes). No imports, no network: use `host.*` services only.
- **Mode A default (`<iframe sandbox="allow-scripts">`)** with an opaque origin: no `allow-same-origin`, no cookies/storage,
  no `parent`/`top`, no `eval`/`new Function`, no direct `fetch`/WebSocket. Mode B (`*.didactum-sandbox.org`) is opt-in
  only for `capabilities.persistentOpfs` after a 150ms `/healthz` preflight probe, with automatic Mode A fallback.
- Talk to the world through `host`: `tts.synthesizeStream`, `realtime.connect`, `tutor.ask` (all optional: check
  `capabilities` and degrade to captions-only). `telemetry.reportPlayback` is deleted in v2 — telemetry is strictly host-authoritative.
- Use `container.ownerDocument` to create elements. Host-service arguments/results are JSON (a `MediaStream` cannot
  cross the Mode A sandbox; real-time video is data/host-docked tile in Mode A).
- **Host is the sequencer:** `seekBeat(beatId, opts?)` must be beat-idempotent (`1→2→3` ≡ `3→1→3`); `appendBeats(beats)`
  inserts host/score beats dynamically; `setLayout(...)` respects host-owned teacher tile placement (`subtitle_dock` on `<640px` portrait).
- Lessons carry no answers, pixels or audio. Never try to recover them; judging a student's reply goes via `tutor.ask`.
- `destroy()` must release timers, audio, sessions and DOM. `interrupt({ reason })` receives structured reasons only.
- Respect `setRate`, `setVolume`, `setMuted`, `setCaptions`, `setTheme('chalk'|'white')`; captions are an accessibility minimum.
