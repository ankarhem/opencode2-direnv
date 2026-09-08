import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createSharedEnvState,
  filterVars,
  reconcileSharedEnv,
  releaseAllSharedEnv,
} from "../src/index.js"

/**
 * Parallel projects share one server process.env. These tests pin the
 * ownership contract: disjoint keys union, shared keys are last-writer-wins,
 * and one project dropping a key must not delete it while another still
 * exports it (the -1/+1 flap this guards against).
 */

const asEnv = (init: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...init })

describe("reconcileSharedEnv across parallel projects", () => {
  it("unions disjoint keys; shared keys are last-writer-wins", () => {
    const state = createSharedEnvState()
    const env = asEnv()
    const a = new Set<string>()
    const b = new Set<string>()

    const ra = reconcileSharedEnv(state, env, "/projA", a, { SHARED: "from-a", ONLY_A: "1" })
    assert.equal(ra.added, 2)
    const rb = reconcileSharedEnv(state, env, "/projB", b, { SHARED: "from-b", ONLY_B: "1" })
    assert.equal(rb.added, 1)
    assert.equal(rb.changed, 1)

    assert.equal(env.SHARED, "from-b")
    assert.equal(env.ONLY_A, "1")
    assert.equal(env.ONLY_B, "1")
  })

  it("dropping a still-owned key is a no-op (no delete, no flap)", () => {
    const state = createSharedEnvState()
    const env = asEnv()
    const ra = reconcileSharedEnv(state, env, "/projA", new Set(), { SHARED: "from-a" })
    const rb = reconcileSharedEnv(state, env, "/projB", new Set(), { SHARED: "from-b" })

    // A drops SHARED while B still exports it: env must keep B's value and
    // report nothing changed (previously: removed=1 + delete, then +1 on B).
    const ra2 = reconcileSharedEnv(state, env, "/projA", ra.nextOwned, {})
    assert.deepEqual([ra2.added, ra2.changed, ra2.removed], [0, 0, 0])
    assert.equal(env.SHARED, "from-b")

    // B re-syncing is equally quiet — no oscillation.
    const rb2 = reconcileSharedEnv(state, env, "/projB", rb.nextOwned, { SHARED: "from-b" })
    assert.deepEqual([rb2.added, rb2.changed, rb2.removed], [0, 0, 0])
  })

  it("releasing the last owner restores the surviving owner's value", () => {
    const state = createSharedEnvState()
    const env = asEnv()
    // B, not A, applied last — env currently carries A's stale value.
    const ra = reconcileSharedEnv(state, env, "/projA", new Set(), { SHARED: "from-a" })
    reconcileSharedEnv(state, env, "/projB", new Set(), { SHARED: "from-b" })
    env.SHARED = "from-a"
    const ra2 = reconcileSharedEnv(state, env, "/projA", ra.nextOwned, {})
    assert.equal(ra2.changed, 1)
    assert.equal(ra2.removed, 0)
    assert.equal(env.SHARED, "from-b")
  })

  it("fully released keys revert to pre-plugin values", () => {
    const state = createSharedEnvState()
    const env = asEnv({ KEEP: "user-value" })
    const r = reconcileSharedEnv(state, env, "/projA", new Set(), { KEEP: "dev-value" })
    assert.equal(r.changed, 1)
    assert.equal(env.KEEP, "dev-value")

    const r2 = reconcileSharedEnv(state, env, "/projA", r.nextOwned, {})
    assert.equal(r2.removed, 1)
    assert.equal(env.KEEP, "user-value")
  })

  it("fully released absent keys are deleted, not left behind", () => {
    const state = createSharedEnvState()
    const env = asEnv()
    const r = reconcileSharedEnv(state, env, "/projA", new Set(), { TEMP: "1" })
    assert.equal(r.added, 1)
    const r2 = reconcileSharedEnv(state, env, "/projA", r.nextOwned, {})
    assert.equal(r2.removed, 1)
    assert.ok(!("TEMP" in env))
  })

  it("teardown releases ownership; survivors keep values, the rest revert", () => {
    const state = createSharedEnvState()
    const env = asEnv({ KEEP: "user-value" })
    const ra = reconcileSharedEnv(state, env, "/projA", new Set(), {
      SHARED: "from-a",
      KEEP: "dev-value",
    })
    const rb = reconcileSharedEnv(state, env, "/projB", new Set(), { SHARED: "from-b" })

    releaseAllSharedEnv(state, env, "/projA", ra.nextOwned)
    assert.equal(env.SHARED, "from-b")
    assert.equal(env.KEEP, "user-value")

    releaseAllSharedEnv(state, env, "/projB", rb.nextOwned)
    assert.ok(!("SHARED" in env))
  })

  it("prototype-named keys round-trip with correct counts", () => {
    const state = createSharedEnvState()
    const env = asEnv()
    const vars = JSON.parse('{"toString":"v","OK":"1"}')
    const r = reconcileSharedEnv(state, env, "/projA", new Set(), filterVars(vars))
    assert.equal(r.added, 2)
    const r2 = reconcileSharedEnv(state, env, "/projA", r.nextOwned, {})
    assert.equal(r2.removed, 2)
    assert.ok(!Object.hasOwn(env, "toString"))
  })
})

describe("filterVars __proto__", () => {
  it("drops __proto__ (assignment would hit the prototype setter, not the env)", () => {
    const parsed: Record<string, string> = JSON.parse('{"__proto__":"x","OK":"1"}')
    assert.deepEqual(filterVars(parsed), { OK: "1" })
  })
})
