# PlayerPlugin v2

A **player** turns a [LessonPackage](lesson-package.v1.json) into a teacher: chalkboard, 3D/interactive lab,
comic storyboard, on-device voice narrator, or a vendor-agnostic live AI teacher tile. Lessons never name a
player; players never edit lessons. Either can be pull-requested independently.

## Module shape (browser ESM)

```js
export function createPlayer(container, { lesson, host, capabilities, assets }) { /* ... */ return controller; }
```

- `lesson` — a validated LessonPackage (answer-free view: `problem.assessment` and `checkin.correct_index` stripped).
- `host` — `HostServices` (below). Every service is optional; read `capabilities` and degrade gracefully
  (captions-only, silent, no video).
- `capabilities` — `{ tts, realtime, tutor }` booleans (plus optional `persistentOpfs` declared by the plugin manifest).
- `assets` — optional array of host-fetched, SRI-verified `{ name, buffer, mimeType }` assets transferred via `MessagePort`.

## Host Is the Sequencer & PlayerController v2

| Method | Meaning |
|---|---|
| `mount()` | render into `container`; resolve when ready (emit `ready`) |
| `play()` / `pause()` | start/stop narration + visuals |
| `seekBeat(beatId, opts?)` | jump to string `beatId` (or backwards-compatible non-negative integer index) with optional `{ offsetMs?, seed? }`. **Beat-idempotent:** seeking `1→2→3` produces the same scene state as `3→1→3`. |
| `seekTime(ms)` | deterministic clock seek (`ms >= 0`) |
| `appendBeats(beats)` | dynamically insert remediation / branching / live-tutor beats (`origin: "score" \| "host"`) |
| `setLayout({ rect, safe_rect, occluded, orientation, teacher_tile_mode })` | host-owned viewport & AI teacher tile slot (`teacher_tile_mode: "none" \| "subtitle_dock" \| "side_lectern" \| "pip"`) |
| `setRate(0.25..4)` `setVolume(0..1)` `setMuted(bool)` `setCaptions(bool)` `setTheme('chalk'\|'white')` | presentation |
| `interrupt({ reason })` | structured barge-in reason only — players never receive raw student text, mic, or camera streams directly |
| `on(event, fn)` | subscribe; returns an unsubscribe function |
| `destroy()` | release everything (audio, WebRTC, listeners, DOM) |

### Host-Owned Layout & AI Teacher Tile Slot

- `teacher_tile_mode`: `"none" | "subtitle_dock" | "side_lectern" | "pip"`
- `orientation`: `"portrait" | "landscape"`
- `rect` / `safe_rect`: `{ x, y, width, height }`
- `occluded`: `boolean`
- On `<640px` portrait viewports (e.g. `390×844`), the host docks the AI teacher tile into the 2-line subtitle strip
  (`teacher_tile_mode: "subtitle_dock"`, `occluded: false`, `0px` board occlusion, expanding only during chalk-still
  conversational turns).

### Events

Canonical events: `ready`, `statechange`, `timeupdate`, `beatchange`, `buffering`, `checkin`, `error`, `complete`,
plus v2 events:

- `statechange_var`: `{ var, value }` — typed, bounded declared state updates (e.g. `{ var: "x", value: 30 }`) for
  sliders, 3D orbit, and manipulatives, validated against declared bounds and strictly distinct from free-text student input.
- `diagnostic`: optional coarse enum/integer player diagnostics only (`{ code, count?, level? }`); never playback
  or mastery attestations.

## HostServices (v2)

```text
tts.synthesizeStream(text, opts)       -> { audioSource, durationMs, wordTimings, visemes?, abort() }
realtime.connect({ lessonId, beatId, mode }) -> { remoteMediaStream, localAudioTrack, sendData, close }
tutor.ask(beatContext, input)          -> server-routed answer (Never-Verbatim guard runs server-side)
```

`telemetry.reportPlayback` is **deleted** in `PlayerPlugin v2`. Playback telemetry is strictly host-authoritative;
untrusted players cannot self-attest playback or completion, and `host.telemetry.reportPlayback` is rejected on
the v2 bridge.

## One Author API, Dual Host Mount

- **Mode A (Default — Opaque `srcdoc` Frame on Main Origin, `sandbox="allow-scripts"`):**
  Runs 95% of players (2D chalkboard, Three.js/WebGL, audio, host-docked teacher tiles) with **zero extra domains**
  (100% K–12 school firewall and LTI-embed compatible). The host fetches SRI-verified ESM + assets and transfers them
  over a `MessageChannel` `MessagePort`. `allow-same-origin` is strictly forbidden.
- **Mode B (Opt-in `capabilities.persistentOpfs` — `https://<player-id>.didactum-sandbox.org`):**
  Used ONLY when a player explicitly declares `capabilities.persistentOpfs: true` (`>10 MB` local weights).
  The host runs `selectMountMode()`, performing a **150ms CORS `/healthz` preflight probe** against
  `https://<player-id>.didactum-sandbox.org/healthz`. If blocked or timed out by a school firewall, the host
  **automatically falls back to Mode A** with the exact same `PlayerController` API.
- **`assertSandbox()` invariants:**
  Mode A forbids `allow-same-origin` (`sandbox="allow-scripts"` only). Mode B permits `allow-same-origin` ONLY when
  paired with a verified cross-site `*.didactum-sandbox.org` origin — NEVER on the main host origin.

Bridge envelope (`v: 2`): `{ v: 2, token, kind: "req"|"res"|"evt", id?, method?, params?, ok?, result?, error?, event?, payload? }`.
Host-to-player `method` is a `PlayerController` v2 method; player-to-host `method` is `host.<service>.<fn>`
(`tts.synthesizeStream`, `realtime.connect`, `tutor.ask`).

## Never-Verbatim & Privacy

Players receive no answers (`problem.assessment`, `checkin.correct_index` stripped) and no raw student text, mic, or
camera streams via `interrupt({ reason })`. Any student response needing evaluation routes through `host.tutor.ask`.
