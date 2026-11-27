# didactum/players

Community teachers for [Didactum](https://didactum.org). A player renders any
[LessonPackage](https://github.com/didactum/lessons) as a chalkboard, comic storyboard, 3D lab, voice narrator,
or vendor-agnostic live AI teacher tile. Players run in dual-mount sandboxes (`<iframe sandbox="allow-scripts">`
Mode A by default; opt-in Mode B `*.didactum-sandbox.org` when `persistentOpfs` is available), pinned by SRI.

## Contribute in one prompt

Paste into Claude Code, Cursor, Codex or Antigravity inside a clone of this repo:

> Read AGENTS.md and prompts/create-player.md, then build a player that **<your idea>**, validate it, preview it, and open a PR.

```
npm run validate   # SRI + safety scan + v2 contract & seek-idempotence test (Node 18+)
npm test           # full JS test suite + validate
npm run preview    # http://localhost:4174, runs your player in the real sandbox bridge
```

Starters: `players/minimal-slides`, `players/live-teacher-tile-stub`. Specs: `spec/player-plugin.v2.md` (and `spec/player-plugin.v1.md`).
`harness/` holds the host-side contract + bridge, copied from Didactum; do not edit it.
