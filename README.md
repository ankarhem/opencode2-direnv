<div align="center">

# opencode2-direnv

**Seamless direnv integration for OpenCode 2**

[![npm version](https://img.shields.io/npm/v/opencode2-direnv?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/opencode2-direnv)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![direnv](https://img.shields.io/badge/direnv-compatible-FFC107?style=flat-square&logo=gnubash&logoColor=white)](https://direnv.net/)

---

*Automatically load [direnv](https://direnv.net/) environment variables into OpenCode 2 sessions — and keep them in sync while you work.*

Fork of [`@simonwjackson/opencode-direnv`](https://github.com/simonwjackson/opencode-direnv), ported to the OpenCode 2 plugin API. OpenCode 1 users should use the original package.

</div>

---

## Overview

The plugin detects `.envrc` files and keeps the OpenCode server environment in sync with your devshell:

- **Automatic Detection** — Searches for `.envrc` from the project directory up to the git root
- **Shell Injection** — Injects the current direnv export into every shell OpenCode spawns (via the `shell.create.before` hook), so agent commands always see the devshell
- **Live Reloading** — Re-applies the devshell when `.envrc`/`flake.nix`/`flake.lock` change (debounced) or a new session starts, and *removes* variables that are dropped
- **Fallback Sync** — Also reconciles `process.env` so other subprocesses (LSP, MCP) inherit the devshell
- **Graceful Degradation** — Silently skips if direnv is not installed or no `.envrc` exists; warns in the logs when a `.envrc` is blocked

## Requirements

- [OpenCode 2](https://opencode.ai/) (`opencode2`, beta)
- [direnv](https://direnv.net/) >= 2.0 in PATH

## Installation

Add the plugin to your OpenCode 2 configuration (`plugins`, not the v1 `plugin` key):

**Project-level** (`./opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode2-direnv"]
}
```

**Global** (`~/.config/opencode/opencode.json`):

```json
{
  "plugins": ["opencode2-direnv"]
}
```

Then allow your `.envrc` once:

```bash
direnv allow
```

## Usage

Start `opencode2` in a project with an `.envrc`. Environment variables are loaded at startup, re-synced per session, and reloaded (debounced ~1.5s) when devshell files change. Outcomes are logged with a `direnv:` prefix:

```
direnv: environment loaded
direnv: reloaded (+2 ~1)
direnv: .envrc is blocked. Run `direnv allow` to enable.
```

### Local development

To dogfood this repository's working tree instead of the published package
(this repo's own setup), disable the published plugin and load a local dev
instance with a **distinct plugin id**:

```jsonc
// opencode.json (project)
{
  "plugins": ["-opencode2-direnv"]
}
```

```ts
// .opencode/plugins/dev/index.ts — auto-discovered, not published
const plugin = (await import(`../../../src/index.js?dev=${Date.now()}`)).default

export default { ...plugin, id: "opencode2-direnv-dev" }
```

Three details matter:

- **Distinct id** — without it the local instance's own `opencode2-direnv` id
  re-enables the disabled package ("a later id re-enables a disabled plugin")
  and then fails with `Duplicate plugin ID`.
- **Cache-busted dynamic import** — OpenCode cache-busts only the entrypoint
  file (`index.ts?mtime=…`); a static import of `src/index.js` is served from
  the module cache for the server's lifetime, so `src/` edits would silently
  run stale code until a service restart. The per-evaluation query makes every
  wrapper reload import the current working tree.
- **`.opencode/plugins/`** — configured path entries must be *directories* on
  current betas; direct files load only from `.opencode/plugins/`.

In other projects (without a globally installed copy), a plain directory entry
also works and needs no disable or distinct id:

```json
{
  "plugins": ["/path/to/opencode-direnv"]
}
```

The root `index.ts` re-exports `src/index.ts`; with the plain entry, edits are
picked up on restart. Typecheck, test, and build with:

```bash
npm ci
npx tsc --noEmit
npm test
npm run build
```

## How It Works

```
plugin setup ────▶ direnv export json ──▶ process.env reconcile
      │                                        │
      ├── shell.create.before hook ────────────┴─▶ every spawned shell gets the devshell
      ├── session.created event ──▶ re-sync per session (e.g. after `direnv allow`)
      └── filesystem.changed event (.envrc/flake.nix/flake.lock) ──▶ debounced reload
```

1. **Discovery** — Searches upward from the plugin's location directory, stopping at the git root
2. **Export** — Runs `direnv export json` (fast when nothing changed; direnv's own watch caches it)
3. **Reconcile** — Applies additions/changes and *removes* dropped keys; explicit direnv unsets (`null` values) are honored. Keys are reference-counted across parallel projects, so one project's reload can't delete another's live vars; fully released keys revert to their pre-plugin values
4. **Inject** — The `shell.create.before` hook copies the cached export into the environment of every shell spawned below the devshell directory

## Troubleshooting

```bash
# Verify direnv is installed and .envrc is allowed
which direnv && direnv status

# Verify the export works in the project directory
direnv export json
```

If the plugin does not activate, check the server logs (`opencode2 run --standalone --print-logs --log-level debug ...`) for `direnv:` lines or plugin load errors.

## Limitations

- Reloads are debounced (~1.5s); run `direnv reload` for an immediate refresh
- `.envrc` must be explicitly allowed (`direnv allow`) — a blocked file is reported in the logs
- A changed `use flake` re-evaluates in the background; the session is never blocked

## License

[MIT](LICENSE) — originally by [@simonwjackson](https://github.com/simonwjackson), ported to the OpenCode 2 plugin API by [@ankarhem](https://github.com/ankarhem).
