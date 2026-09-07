import { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

/**
 * Direnv Auto-Loader Plugin for OpenCode 2
 *
 * Automatically loads AND keeps in sync environment variables from direnv.
 * Shell commands run by the agent always see the current devshell state, even
 * after the user edits .envrc/flake.nix or runs `direnv reload` mid-session.
 *
 * Behavior:
 * - On plugin setup: load env once (awaited, so the first command is ready)
 * - On session.created: re-sync per new session (e.g. after `direnv allow`)
 * - On filesystem.changed for .envrc/flake.nix/flake.lock: debounced reload
 * - Injects the latest direnv export into every spawned shell via the
 *   `shell.create.before` hook (primary mechanism)
 * - Reconciles process.env as a fallback for other subprocesses (LSP, MCP) and
 *   *removes* dropped keys so removed variables don't linger
 * - Logs outcomes with a `direnv:` prefix (blocked .envrc is always reported)
 * - Silently skips if direnv is not installed or .envrc is missing
 *
 * Environment hygiene (self-healing):
 *
 * `nix print-dev-env` exports a `shellHook` variable whose value is the raw
 * shell *script* of the devShell hook, typically ending with a line like
 * `export PATH=/nix/store/…:$PATH`. OpenCode 2 parses that text naively and
 * can end up with a bogus env entry literally named `export PATH`, and a PATH
 * value containing a literal `$PATH` breaks every spawned subprocess (local
 * MCP servers die with `MCP error -32000: Connection closed`). Once PATH is
 * corrupted, `execFile("direnv")` fails with ENOENT, so without the repair
 * below the devShell environment can never load again — a permanent breakage
 * loop.
 *
 * Therefore, on every load: strip the poison, repair PATH before invoking
 * direnv, resolve direnv by absolute path as a fallback, and never apply
 * variables that are env-name-invalid or whose value is a shell script.
 */

const run = promisify(execFile)

type ReloadOutcome = {
  /** .envrc exists but is blocked (`direnv allow` needed) */
  blocked: boolean
  /** direnv not installed / no .envrc / discovery failed */
  unavailable: boolean
  /** a transient error occurred talking to direnv */
  error: boolean
  /** number of brand-new variables added to process.env */
  added: number
  /** number of existing variables whose value changed */
  changed: number
  /** number of previously-applied variables that were removed */
  removed: number
}

/** Minimal shapes of the v2 server events this plugin reacts to */
type EncodedEvent = {
  readonly type: string
  readonly data?: unknown
  readonly location?: { readonly directory?: string } | undefined
}

type SessionCreatedData = { readonly sessionID?: string }
type FilesystemChangedData = { readonly file?: string }

/** devshell files whose modification should trigger a reload */
const RELEVANT_FILES = new Set([".envrc", "flake.nix", "flake.lock"])

/** debounce window for background reloads (ms) */
const RELOAD_DEBOUNCE_MS = 1500

/** variables whose values are shell scripts, not environment data */
const SCRIPT_VARS = new Set(["shellHook", "buildPhase", "phases", "prePhases", "postPhases"])

/** known-broken env entries to remove from process.env */
const POISON_VARS = ["shellHook", ...SCRIPT_VARS, "export PATH"]

/** valid POSIX environment variable names */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** fallback PATHs used when repairing a corrupted PATH */
const sanePath = () => {
  const parts: string[] = []
  if (process.env.HOST_PATH) parts.push(process.env.HOST_PATH)
  if (process.env.HOME) parts.push(`${process.env.HOME}/.nix-profile/bin`)
  if (process.env.USER) parts.push(`/etc/profiles/per-user/${process.env.USER}/bin`)
  parts.push(
    "/nix/var/nix/profiles/default/bin",
    "/run/current-system/sw/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin:/bin:/usr/sbin:/sbin",
  )
  return parts.join(":")
}

/** candidate locations for direnv, absolute paths first so that a PATH
 * corruption after setup cannot break the cached resolution */
const direnvCandidates = () =>
  [
    `/etc/profiles/per-user/${process.env.USER ?? ""}/bin/direnv`,
    `${process.env.HOME ?? ""}/.nix-profile/bin/direnv`,
    "/run/current-system/sw/bin/direnv",
    "/opt/homebrew/bin/direnv",
    "/usr/local/bin/direnv",
  ]
    .filter((candidate) => !candidate.includes("//"))
    .concat("direnv")

/** Strip known poison from process.env; returns the removed keys. */
const stripPoison = (): string[] => {
  const removed: string[] = []
  for (const key of POISON_VARS) {
    if (key in process.env) {
      delete process.env[key]
      removed.push(key)
    }
  }
  return removed
}

/**
 * Repair process.env.PATH if it is corrupted (contains a literal `$`),
 * returning the usable PATH. A corrupted PATH otherwise makes direnv (and
 * every other subprocess this plugin could help) unlaunchable.
 */
const repairPath = (): string => {
  const current = process.env.PATH
  if (current && !current.includes("$")) return current
  const fallback = sanePath()
  process.env.PATH = fallback
  console.warn(`direnv: repaired corrupted PATH (was ${JSON.stringify(current)})`)
  return fallback
}

/** Resolve direnv once; prefers absolute locations, falls back to PATH. */
let direnvPath: string | null | undefined
const findDirenv = async (): Promise<string | null> => {
  if (direnvPath !== undefined) return direnvPath
  for (const candidate of direnvCandidates()) {
    try {
      await run(candidate, ["version"], { encoding: "utf8" })
      direnvPath = candidate
      return direnvPath
    } catch {
      // try next candidate
    }
  }
  direnvPath = null
  return direnvPath
}

/**
 * Strip poison and repair PATH. Runs before every direnv invocation so a
 * daemon that gets corrupted mid-flight heals itself on the next reload.
 * Returns true if anything was repaired.
 */
const sanitize = (): boolean => {
  const stripped = stripPoison()
  if (stripped.length > 0) {
    console.warn(`direnv: stripped poison vars from process.env: ${stripped.join(", ")}`)
  }
  const before = process.env.PATH
  repairPath()
  return stripped.length > 0 || process.env.PATH !== before
}

const runText = async (file: string, args: string[], cwd: string) => {
  const { stdout } = await run(file, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

export default Plugin.define({
  id: "opencode2-direnv",

  async setup(ctx) {
    const directory = ctx.location.directory

    /**
     * Sessions already synced by this plugin instance. Events arrive for every
     * location, so also filter by event location where one is present.
     */
    const loadedSessions = new Set<string>()

    /**
     * Keys we have written into process.env. Tracked globally (process.env is
     * shared across locations in the server process) so reloads can remove vars
     * that the devshell no longer exports without touching anything we didn't set.
     */
    const appliedKeys = new Set<string>()

    /** latest successful `direnv export json` payload, injected into spawned shells */
    let currentVars: Record<string, string> = {}

    /** cached .envrc location (only cached once successfully found) */
    let envrcDir: string | null = null
    let discovered = false

    /** prevents overlapping `direnv export json` invocations */
    let reloading = false

    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    let firstLoadComplete = false

    const findGitRoot = async (): Promise<string | null> => {
      try {
        const result = await runText("git", ["rev-parse", "--show-toplevel"], directory)
        return result.trim() || null
      } catch {
        return null
      }
    }

    /**
     * Find .envrc file searching from directory up to stopAt (git root or filesystem root)
     */
    const findEnvrc = async (
      startDir: string,
      stopAt: string | null
    ): Promise<string | null> => {
      let current = startDir
      const boundary = stopAt || "/"

      while (true) {
        if (existsSync(join(current, ".envrc"))) {
          return join(current, ".envrc")
        }

        if (current === boundary || current === "/") {
          break
        }

        const parent = dirname(current)
        if (parent === current) {
          break
        }

        current = parent
      }

      return null
    }

    /**
     * Resolve (and cache) the directory containing .envrc.
     * Caches only on success; a missing .envrc is re-checked on later triggers
     * so one created mid-session is eventually picked up.
     */
    const resolveEnvrcDir = async (): Promise<string | null> => {
      if (discovered) return envrcDir
      const gitRoot = await findGitRoot()
      const envrcPath = await findEnvrc(directory, gitRoot)
      if (envrcPath) {
        envrcDir = dirname(envrcPath)
      }
      discovered = envrcPath !== null
      return envrcDir
    }

    const newOutcome = (): ReloadOutcome => ({
      blocked: false,
      unavailable: false,
      error: false,
      added: 0,
      changed: 0,
      removed: 0,
    })

    /**
     * Re-run `direnv export json` and reconcile process.env.
     *
     * Idempotent and mutex-guarded: safe to call from any trigger. Cheap when
     * nothing changed (direnv's own watch cache makes the export ~milliseconds).
     * Returns a summary describing what (if anything) changed.
     */
    const reloadEnv = async (): Promise<ReloadOutcome> => {
      const outcome = newOutcome()
      if (reloading) return outcome
      reloading = true

      try {
        // Self-heal before touching direnv: a corrupted PATH would make the
        // direnv lookup below fail with ENOENT forever.
        sanitize()

        const dir = await resolveEnvrcDir()
        if (!dir) {
          outcome.unavailable = true
          return outcome
        }

        const direnv = await findDirenv()
        if (!direnv) {
          outcome.unavailable = true
          return outcome
        }

        let jsonText: string
        try {
          jsonText = await runText(direnv, ["export", "json"], dir)
        } catch (error: unknown) {
          const stderr =
            error && typeof error === "object" && "stderr" in error
              ? String((error as { stderr?: string }).stderr ?? "")
              : ""
          if (stderr.includes("is blocked")) {
            outcome.blocked = true
          } else {
            outcome.error = true
          }
          return outcome
        }

        const parsed = jsonText.trim() ? JSON.parse(jsonText) : {}
        const newVars: Record<string, string> =
          parsed && typeof parsed === "object" ? parsed : {}

        // 1. Remove vars we previously applied that the devshell no longer exports.
        //    direnv may also emit explicit `null` values to signal unsets.
        for (const key of appliedKeys) {
          const keep = key in newVars && newVars[key] != null
          if (!keep && key in process.env) {
            delete process.env[key]
            outcome.removed++
          }
        }

        // 2. Apply current vars, counting additions and value changes.
        //    Skip invalid names (e.g. a phantom `export PATH` entry) and
        //    script-valued vars (e.g. nix's `shellHook`) — they corrupt
        //    subprocess environments instead of configuring them.
        const nextApplied = new Set<string>()
        for (const [key, value] of Object.entries(newVars)) {
          if (value == null) continue
          if (!VALID_NAME.test(key) || SCRIPT_VARS.has(key)) continue
          const current = process.env[key]
          if (current === undefined) outcome.added++
          else if (current !== value) outcome.changed++
          process.env[key] = value
          nextApplied.add(key)
        }

        appliedKeys.clear()
        for (const key of nextApplied) appliedKeys.add(key)
        currentVars = newVars

        return outcome
      } catch {
        outcome.error = true
        return outcome
      } finally {
        reloading = false
      }
    }

    /**
     * Surface a reload result via logs.
     *
     * - blocked: always warn (action required by the user)
     * - first load: confirm the environment was applied
     * - subsequent: only log when something actually changed
     * - no-op / unavailable / transient error: silent
     */
    const logOutcome = (outcome: ReloadOutcome, opts: { initial: boolean }) => {
      if (outcome.blocked) {
        console.warn("direnv: .envrc is blocked. Run `direnv allow` to enable.")
        return
      }
      if (outcome.unavailable || outcome.error) return

      const total = outcome.added + outcome.changed + outcome.removed

      if (opts.initial && !firstLoadComplete) {
        firstLoadComplete = true
        if (total > 0 || appliedKeys.size > 0) {
          console.log("direnv: environment loaded")
        }
        return
      }

      if (total > 0) {
        const parts: string[] = []
        if (outcome.added) parts.push(`+${outcome.added}`)
        if (outcome.changed) parts.push(`~${outcome.changed}`)
        if (outcome.removed) parts.push(`-${outcome.removed}`)
        console.log(`direnv: reloaded (${parts.join(" ")})`)
      }
    }

    /**
     * Debounced background reload. Collapses rapid triggers (e.g. many file
     * writes from an editor save) into a single reload.
     */
    const scheduleReload = (delayMs: number) => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void reloadEnv().then((outcome) => logOutcome(outcome, { initial: false }))
      }, delayMs)
    }

    // Initial load: awaited so the first command of any session sees the env.
    logOutcome(await reloadEnv(), { initial: true })

    // Primary mechanism: inject the latest direnv export into every shell the
    // server spawns for a working copy inside the devshell. The cached payload
    // keeps the hook synchronous and non-blocking.
    const shellRegistration = await ctx.shell.hook("create.before", (event) => {
      if (!envrcDir) return
      if (event.cwd !== envrcDir && !event.cwd.startsWith(`${envrcDir}/`)) return
      for (const [key, value] of Object.entries(currentVars)) {
        event.env[key] = value
      }
    })

    const isRelevantLocation = (location: EncodedEvent["location"]) =>
      !location?.directory || location.directory === directory

    // Event stream: per-session sync and devshell-file watch. Runs detached so
    // plugin setup is never blocked; aborted on cleanup.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const event = raw as unknown as EncodedEvent

          // Re-sync on new sessions (catches `direnv allow` and other state
          // changes that don't touch watched files).
          if (event.type === "session.created") {
            const data = event.data as SessionCreatedData | undefined
            const sessionID = data?.sessionID
            if (!sessionID || !isRelevantLocation(event.location)) continue
            if (loadedSessions.has(sessionID)) continue
            loadedSessions.add(sessionID)
            const outcome = await reloadEnv()
            logOutcome(outcome, { initial: false })
            continue
          }

          // Devshell file edited/created/deleted -> reload (debounced).
          if (event.type === "filesystem.changed") {
            const data = event.data as FilesystemChangedData | undefined
            const filename = (data?.file ?? "").split("/").pop() ?? ""
            if (!isRelevantLocation(event.location)) continue
            if (RELEVANT_FILES.has(filename)) {
              scheduleReload(RELOAD_DEBOUNCE_MS)
            }
          }
        }
      } catch {
        // stream aborted on cleanup or failed; nothing to do
      }
    })()

    return () => {
      controller.abort()
      if (reloadTimer) clearTimeout(reloadTimer)
      void shellRegistration.dispose()
    }
  },
})
