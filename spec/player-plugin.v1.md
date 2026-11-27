# PlayerPlugin v1

A **player** turns a [LessonPackage v1](lesson-package.v1.json) into a teacher: chalkboard, comic storyboard, 3D lab,
on-device voice narrator, or a real-time video tutor. Lessons never name a player; players never
edit lessons. Either can be pull-requested independently.

## Module shape (browser ESM)

```js
export function createPlayer(container, { lesson, host, capabilities }) { /* ... */ return controller; }
```

- `lesson` — a validated LessonPackage (answer-free view: `problem.assessment` and `checkin.correct_index` stripped).
- `host` — `HostServices` (below). Every service is optional; read `capabilities` and degrade gracefully
  (captions-only, silent, no video).
- `capabilities` — `{ tts, realtime, tutor, telemetry }` booleans.

## PlayerController

| Method | Meaning |
|---|---|
| `mount()` | render into `container`; resolve when ready (emit `ready`) |
| `play()` / `pause()` | start/stop narration + visuals |
| `seekBeat(index)` / `seekTime(ms)` | jump (flat beat index across chapters / ms from start) |
| `setRate(0.25..4)` `setVolume(0..1)` `setMuted(bool)` `setCaptions(bool)` `setTheme('chalk'\|'white')` | presentation |
| `interrupt(studentInput)` | barge-in: the student spoke/typed mid-beat; conversational teachers answer, others pause |
| `on(event, fn)` | subscribe; returns an unsubscribe function |
| `destroy()` | release everything (audio, WebRTC, listeners, DOM) |

Events: `ready`, `statechange`, `timeupdate`, `beatchange`, `buffering`, `checkin`, `error`, `complete`.

## HostServices

```text
tts.synthesizeStream(text, opts) -> { audioSource, durationMs, wordTimings, visemes?, abort() }
realtime.connect({ lessonId, beatId, mode }) -> { remoteMediaStream, localAudioTrack, sendData, close }
tutor.ask(beatContext, input)       -> server-routed answer (Never-Verbatim guard runs server-side)
telemetry.reportPlayback(attestation)
```

`realtime.connect` is the full-duplex hook (WebRTC / WebSocket) for a real-time client-side video teacher.

## Two tiers

- **Tier A — first-party**: runs in the host page, reviewed and shipped with Didactum.
- **Tier B — community**: listed in `players-registry.json` with a pinned `sha384` SRI. The host fetches the module,
  verifies SRI, and runs it inside `<iframe sandbox="allow-scripts">` (opaque origin; **never** `allow-same-origin`)
  via `static/js/player/iframe_bridge.js` (`createSandboxedPlayer`). All communication is `postMessage` over a
  `MessageChannel` with a handshake token and strict message validation. Host services are proxied as RPC
  (`host.tts.synthesizeStream`, ...), so arguments and results must be structured-clone/JSON data. A
  `MediaStream` cannot cross that boundary: Tier-B `realtime.connect` carries data only (`sendData`, events);
  video-from-stream teachers are Tier A.

Bridge envelope: `{ v: 1, token, kind: "req"|"res"|"evt", id?, method?, params?, ok?, result?, error?, event?, payload? }`.
Host to player `method` is a PlayerController method; player to host `method` is `host.<service>.<fn>`.
Messages with a bad version, token, shape, method or event are dropped; RPCs time out; plugin errors surface as `error`.

## Never-Verbatim

Players receive no answer. Anything a student types that needs judging goes through `host.tutor.ask`.
