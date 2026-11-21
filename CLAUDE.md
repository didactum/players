# AGENTS.md — building a Didactum player

You are building a **player**: a teacher that consumes any LessonPackage v1 and presents it (chalkboard, comic
storyboard, 3D lab, on-device voice narrator, Tavus Griffin real-time video tutor). You never edit lessons; they live in
[didactum/lessons](https://github.com/didactum/lessons). Read `spec/player-plugin.v1.md` first, then copy
`players/minimal-slides/index.js` (complete, ~70 lines) or `players/griffin-video-stub/index.js` (real-time video).

## The loop

1. `players/<your-id>/index.js` exporting `createPlayer(container, { lesson, host, capabilities })` → PlayerController
   with every method in the spec (`mount play pause seekBeat seekTime setRate setVolume setMuted setCaptions setTheme interrupt on destroy`)
   and the canonical events (`ready statechange timeupdate beatchange buffering checkin error complete`).
2. Add an entry to `players-registry.json` (`tier: "B"`), then `npm run sri` to pin the `sha384`.
3. `npm run validate` until `OK`, then `npm run preview` and try your player in the real sandbox.
4. Open a PR. CI re-checks SRI, forbidden APIs and the contract.

## Hard rules (CI enforces them)

- **One self-contained file** per player (SRI pins its bytes). No imports, no network: use `host.*` services only.
- **You run in `<iframe sandbox="allow-scripts">`** with an opaque origin: no `allow-same-origin`, no cookies/storage,
  no `parent`/`top`, no `eval`/`new Function`, no direct `fetch`/WebSocket. Talk to the world through `host`:
  `tts.synthesizeStream`, `realtime.connect`, `tutor.ask`, `telemetry.reportPlayback`. All optional: check `capabilities`
  and degrade to captions-only.
- Use `container.ownerDocument` to create elements. Host-service arguments/results are JSON (a `MediaStream` cannot
  cross the sandbox; real-time video is data-only in Tier B).
- Lessons carry no answers, pixels or audio. Never try to recover them; judging a student's reply goes via `tutor.ask`.
- `destroy()` must release timers, audio, sessions and DOM. `interrupt(studentInput)` must stop the current beat.
- Respect `setRate`, `setVolume`, `setMuted`, `setCaptions`, `setTheme('chalk'|'white')`; captions are an accessibility minimum.
