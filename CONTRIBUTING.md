# Contributing a player

1. Fork, branch `player/<id>`.
2. Add `players/<id>/index.js` (single file) and a `players-registry.json` entry; run `npm run sri`.
3. `npm run validate` and `npm run preview` must work locally.
4. One player per PR. Describe the teaching style, capabilities used, and any real-time/video provider terms.
5. Reviewers check: sandbox rules, accessibility (captions, keyboard), graceful degradation, clean `destroy()`.

MIT licensed. Never commit API keys: providers are reached through host services, which the host configures.
