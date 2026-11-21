# didactum/players

Community teachers for [Didactum](https://didactum.org). A player renders any
[LessonPackage](https://github.com/didactum/lessons) as a chalkboard, comic storyboard, 3D lab, voice narrator,
or real-time video tutor (Tavus Griffin). Players run sandboxed (`<iframe sandbox="allow-scripts">`), pinned by SRI.

## Contribute in one prompt

Paste into Claude Code, Cursor, Codex or Antigravity inside a clone of this repo:

> Read AGENTS.md and prompts/create-player.md, then build a player that **<your idea>**, validate it, preview it, and open a PR.

```
npm run validate   # SRI + safety scan + contract smoke test (Node 18+)
npm run preview    # http://localhost:4174, runs your player in the real sandbox bridge
```

Starters: `players/minimal-slides`, `players/griffin-video-stub`. Spec: `spec/player-plugin.v1.md`.
`harness/` holds the host-side contract + bridge, copied from Didactum; do not edit it.
