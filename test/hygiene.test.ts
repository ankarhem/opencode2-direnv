import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  baselinePath,
  direnvCandidates,
  exportBaseline,
  filterVars,
  nearestEnvrc,
  probeDirenv,
  repairPath,
  sanePath,
  stripPoison,
} from "../src/index.js"

/**
 * The scenario these tests guard against: `nix print-dev-env` exports a
 * `shellHook` variable containing the raw devShell hook script (ending with
 * `export PATH=/nix/store/…:$PATH`). OpenCode 2 parses that text naively,
 * producing an env entry literally named `export PATH` and a PATH value
 * containing a literal `$PATH` — which kills every spawned subprocess.
 */

const POISON_ENV = {
  shellHook: "echo hi\nexport PATH=/nix/store/aaa-pre-commit/bin:$PATH\n\n",
  "export PATH": "/nix/store/aaa-pre-commit/bin:$PATH",
  buildPhase: "echo building",
  phases: "buildPhase",
}

/** snapshot + restore the env vars a test touches */
const snapshot = () => {
  const keys = [...Object.keys(POISON_ENV), "PATH", "HOST_PATH", "HOME", "USER"]
  return new Map(keys.map((key) => [key, process.env[key]]))
}
const restore = (snap: Map<string, string | undefined>) => {
  for (const [key, value] of snap) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe("stripPoison", () => {
  let snap: Map<string, string | undefined>
  beforeEach(() => {
    snap = snapshot()
    Object.assign(process.env, POISON_ENV)
  })
  afterEach(() => restore(snap))

  it("removes the phantom `export PATH` entry and script-valued nix vars", () => {
    const removed = stripPoison()
    for (const key of Object.keys(POISON_ENV)) {
      assert.ok(removed.includes(key), `should remove ${key}`)
      assert.equal(key in process.env, false, `${key} should be gone from process.env`)
    }
  })

  it("leaves regular variables untouched", () => {
    process.env.DIRENV_KEEP_ME = "yes"
    stripPoison()
    assert.equal(process.env.DIRENV_KEEP_ME, "yes")
  })

  it("is a no-op on a clean environment", () => {
    for (const key of Object.keys(POISON_ENV)) delete process.env[key]
    assert.deepEqual(stripPoison(), [])
  })
})

describe("exportBaseline", () => {
  let snap: Map<string, string | undefined>
  beforeEach(() => {
    snap = snapshot()
    process.env.HOME = "/home/tester"
    process.env.USER = "tester"
    process.env.PATH = "/usr/bin:/bin"
    process.env.TERM = "dumb"
    delete process.env.TMPDIR
  })
  afterEach(() => restore(snap))

  it("is a fixed minimal set, independent of ambient devshell variables", () => {
    process.env.API_URL = "https://api.example.com/v1"
    process.env.NIX_CFLAGS_COMPILE = "-O2"
    const baseline = exportBaseline()
    assert.equal(baseline.HOME, "/home/tester")
    assert.equal(baseline.PATH, baselinePath(), "PATH comes from baselinePath, not process.env")
    assert.ok(!("API_URL" in baseline), "devshell vars must not leak into the baseline")
    assert.ok(!("NIX_CFLAGS_COMPILE" in baseline))
  })

  it("omits unset keys instead of passing undefined values", () => {
    const baseline = exportBaseline()
    assert.ok(!("TMPDIR" in baseline))
    for (const value of Object.values(baseline)) {
      assert.ok(typeof value === "string", `undefined leaked: ${String(value)}`)
    }
  })

  it("always carries a stable PATH, never derived from process.env.PATH or HOST_PATH", () => {
    process.env.PATH = "/nix/store/aaa/bin:$PATH"
    process.env.HOST_PATH = "/nix/store/host/bin"
    const baseline = exportBaseline()
    assert.ok(!baseline.PATH!.includes("$"), "PATH must never contain a literal $")
    assert.ok(!baseline.PATH!.includes("/nix/store/host/bin"), "HOST_PATH must not feed back in")
    assert.ok(baseline.PATH!.includes("/usr/bin"), "PATH must include system paths")
    assert.equal(baseline.PATH, exportBaseline().PATH, "PATH must be deterministic")
  })

  it("is deterministic: same environment yields the same baseline", () => {
    assert.deepEqual(exportBaseline(), exportBaseline())
  })
})

describe("filterVars", () => {
  it("drops invalid env names such as the phantom `export PATH`", () => {
    const filtered = filterVars({
      "export PATH": "/nix/store/aaa/bin:$PATH",
      PATH: "/good/path",
    })
    assert.deepEqual(filtered, { PATH: "/good/path" })
  })

  it("drops script-valued nix variables", () => {
    const filtered = filterVars({
      shellHook: "export PATH=/nix/store/aaa/bin:$PATH",
      buildPhase: "echo nope",
      CC: "clang",
    })
    assert.deepEqual(filtered, { CC: "clang" })
  })

  it("drops null and undefined values (direnv unset signals)", () => {
    const filtered = filterVars({ GONE: null, ALSO_GONE: undefined, KEPT: "1" })
    assert.deepEqual(filtered, { KEPT: "1" })
  })

  it("drops direnv bookkeeping variables that churn per invocation", () => {
    const filtered = filterVars({
      DIRENV_DIFF: "eJx…hash-of-diff",
      DIRENV_WATCHES: "eJw…watch-state",
      API_URL: "https://api.example.com/v1",
    })
    assert.deepEqual(filtered, { API_URL: "https://api.example.com/v1" })
  })
})

describe("repairPath", () => {
  let snap: Map<string, string | undefined>
  beforeEach(() => {
    snap = snapshot()
    delete process.env.HOST_PATH
    process.env.HOME = "/home/tester"
    process.env.USER = "tester"
  })
  afterEach(() => restore(snap))

  it("leaves a healthy PATH alone", () => {
    process.env.PATH = "/usr/bin:/bin"
    assert.equal(repairPath(), "/usr/bin:/bin")
    assert.equal(process.env.PATH, "/usr/bin:/bin")
  })

  it("repairs a PATH containing a literal $PATH", () => {
    process.env.PATH = "/nix/store/aaa-pre-commit/bin:$PATH"
    const repaired = repairPath()
    assert.ok(!repaired.includes("$"), "repaired PATH must not contain a literal $")
    assert.equal(process.env.PATH, repaired)
    assert.ok(repaired.includes("/usr/bin"), "repaired PATH must include system paths")
  })

  it("repairs a missing PATH", () => {
    delete process.env.PATH
    const repaired = repairPath()
    assert.ok(repaired.length > 0)
    assert.equal(process.env.PATH, repaired)
  })

  it("prefers nix's HOST_PATH when present", () => {
    process.env.HOST_PATH = "/nix/store/host-path/bin"
    process.env.PATH = "broken:$PATH"
    const repaired = repairPath()
    assert.ok(repaired.startsWith("/nix/store/host-path/bin"), "HOST_PATH should come first")
    assert.ok(!repaired.includes("$"), "repaired PATH must not contain a literal $")
    assert.ok(repaired.includes("/usr/bin"), "system paths should still be present")
  })
})

describe("sanePath", () => {
  let snap: Map<string, string | undefined>
  beforeEach(() => {
    snap = snapshot()
    process.env.HOME = "/home/tester"
    process.env.USER = "tester"
    delete process.env.HOST_PATH
  })
  afterEach(() => restore(snap))

  it("includes nix, homebrew and system locations", () => {
    const path = sanePath()
    assert.ok(path.includes("/home/tester/.nix-profile/bin"))
    assert.ok(path.includes("/etc/profiles/per-user/tester/bin"))
    assert.ok(path.includes("/run/current-system/sw/bin"))
    assert.ok(path.includes("/opt/homebrew/bin"))
    assert.ok(path.includes("/usr/bin"))
  })

  it("never produces empty segments from unset HOME/USER", () => {
    delete process.env.HOME
    delete process.env.USER
    const segments = sanePath().split(":")
    assert.ok(segments.every((segment) => segment.length > 0), `empty segments in ${segments}`)
    assert.ok(!segments.some((segment) => segment.includes("//")))
  })
})

describe("direnvCandidates", () => {
  let snap: Map<string, string | undefined>
  beforeEach(() => {
    snap = snapshot()
    process.env.HOME = "/home/tester"
    process.env.USER = "tester"
  })
  afterEach(() => restore(snap))

  it("lists absolute paths first and the PATH lookup last", () => {
    const candidates = direnvCandidates()
    assert.equal(candidates.at(-1), "direnv")
    assert.ok(candidates.slice(0, -1).every((candidate) => candidate.startsWith("/")))
  })

  it("contains no malformed entries when HOME/USER are unset", () => {
    delete process.env.HOME
    delete process.env.USER
    const candidates = direnvCandidates()
    assert.ok(candidates.every((candidate) => !candidate.includes("//")))
    assert.ok(candidates.every((candidate) => candidate.length > 0))
  })
})

describe("probeDirenv", () => {
  it("returns the first candidate that executes successfully", async () => {
    const exec = async (file: string) => {
      if (file === "/broken/direnv") throw new Error("ENOENT")
      if (file === "/works/direnv") return "2.37.1"
      throw new Error(`unexpected candidate ${file}`)
    }
    assert.equal(await probeDirenv(["/broken/direnv", "/works/direnv"], exec), "/works/direnv")
  })

  it("returns null when no candidate works", async () => {
    const exec = async () => {
      throw new Error("ENOENT")
    }
    assert.equal(await probeDirenv(["/nope/direnv", "direnv"], exec), null)
  })

  it("prefers earlier candidates over later ones", async () => {
    const exec = async () => "2.37.1"
    assert.equal(await probeDirenv(["/a/direnv", "/b/direnv"], exec), "/a/direnv")
  })
})

describe("nearestEnvrc", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opencode2-direnv-test-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("finds .envrc in the start directory", () => {
    writeFileSync(join(dir, ".envrc"), "use flake\n")
    assert.equal(nearestEnvrc(dir, null), join(dir, ".envrc"))
  })

  it("walks up to parent directories", () => {
    const nested = join(dir, "a", "b")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(dir, ".envrc"), "use flake\n")
    assert.equal(nearestEnvrc(nested, null), join(dir, ".envrc"))
  })

  it("does not walk past the stopAt boundary", () => {
    const nested = join(dir, "a", "b")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(dir, ".envrc"), "use flake\n")
    assert.equal(nearestEnvrc(nested, join(dir, "a")), null)
  })

  it("returns null when there is no .envrc anywhere above", () => {
    const nested = join(dir, "x", "y")
    mkdirSync(nested, { recursive: true })
    assert.equal(nearestEnvrc(nested, join(dir, "x")), null)
  })
})
