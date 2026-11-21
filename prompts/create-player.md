# Prompt: create a Didactum player

You are a front-end engineer building a teacher. Idea: **{{PLAYER_IDEA}}**.

1. Read `spec/player-plugin.v1.md` and `players/minimal-slides/index.js`.
2. Create `players/<id>/index.js`: a single dependency-free ES module exporting
   `createPlayer(container, { lesson, host, capabilities })` that returns the full PlayerController and emits the
   canonical events. Render each beat's `visuals` semantically (they have a `type`, `props` and a relative
   `layout.region`; never invent pixel data) and speak or caption `narration.text`; reveal visuals on `narration.cues`.
3. Use only `host.tts`, `host.realtime`, `host.tutor`, `host.telemetry`, each behind a `capabilities` check with a
   captions-only fallback. Do not use network, storage, eval, parent/top.
4. Handle `interrupt()` (barge-in), `seekBeat`, `setRate`, `destroy` cleanly.
5. Register it in `players-registry.json` (tier "B"), run `npm run sri`, `npm run validate`, `npm run preview`, then open a PR.
