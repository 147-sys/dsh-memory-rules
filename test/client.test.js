/*!
 * dsh-memory-rules — 记忆与规则 client half: registration smoke test.
 *
 * The browser bundle cannot be rendered without the shell's React, so this
 * test runs its `apply()` against a stub context and asserts the three
 * contributions it makes: the toast overlay, the `memory-library` main panel
 * (now the 记忆与规则 page with two tabs) and the sidebar row directly after
 * `dsh-context`, labelled 记忆与规则.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** Load the bundle with a fake module loader and return its exports. */
async function loadBundle() {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load: (value) => {
        definition = value
      }
    }
  }
  await import(`../lib/client.js?smoke=${Date.now()}${Math.random()}`)
  assert.equal(definition?.id, "dsh-memory-rules")

  const react = {
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    Fragment: Symbol("Fragment"),
    createElement: () => null
  }
  const runtime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props })
  }
  const primitives = new Proxy({}, { get: () => () => null })
  const require = (id) => {
    if (id === "react") return react
    if (id === "react/jsx-runtime") return runtime
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives
    throw new Error(`unexpected require: ${id}`)
  }
  return definition.factory(require)
}

function makeContext() {
  const effects = []
  const registrations = []
  let mounted
  let unmounted = false
  const ctx = {
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === "function") effects.push(disposer)
    },
    slots: {
      inject(name, callback) {
        const result = callback()
        registrations.push({ name, result })
        return () => {}
      },
      register(options, component) {
        return { options, component }
      }
    },
    remote: {
      async $mount(spec) {
        mounted = spec
        return async () => {
          unmounted = true
        }
      }
    },
    get() {
      return undefined
    }
  }
  return { ctx, registrations, effects, getMounted: () => mounted, wasUnmounted: () => unmounted }
}

test("client: registers the main panel, sidebar row and toast overlay", async () => {
  const bundle = await loadBundle()
  const harness = makeContext()
  const cleanup = await bundle.apply(harness.ctx)

  const mounted = harness.getMounted()
  assert.equal(mounted.package, "dsh-memory-rules")
  // The belief add/archive paths are gone; the prompt methods are new.
  assert.deepEqual(mounted.descriptors.map((d) => d.method), [
    "list",
    "update",
    "deleteBelief",
    "listPrompts",
    "createPrompt",
    "updatePrompt",
    "deletePrompt"
  ])
  assert.deepEqual(
    mounted.descriptors.map((d) => d.id),
    [
      "dsh-memory-rules#memoryLibrary/list",
      "dsh-memory-rules#memoryLibrary/update",
      "dsh-memory-rules#memoryLibrary/deleteBelief",
      "dsh-memory-rules#memoryLibrary/listPrompts",
      "dsh-memory-rules#memoryLibrary/createPrompt",
      "dsh-memory-rules#memoryLibrary/updatePrompt",
      "dsh-memory-rules#memoryLibrary/deletePrompt"
    ]
  )
  assert.ok(mounted.descriptors.every((d) => d.service === "memoryLibrary" && d.namespace === "memoryLibrary"))

  const main = harness.registrations.find((entry) => entry.name === "main")
  assert.ok(main, "main panel registered")
  assert.equal(main.result.options.key, "memory-library")

  const panel = harness.registrations.find((entry) => entry.name === "sidebar.panellist")
  assert.ok(panel, "sidebar row registered")
  assert.equal(panel.result.options.id, "memory-library")
  assert.equal(panel.result.options.order, 30, "placed after 上下文洞察 (order 20)")
  assert.equal(panel.result.options.label, "记忆与规则")
  assert.equal(typeof panel.result.component, "function")

  assert.ok(harness.registrations.some((entry) => entry.name === "shell.overlay"))

  assert.equal(typeof cleanup, "function")
  await cleanup()
  assert.equal(harness.wasUnmounted(), true)
})

test("client: the sidebar glyph is a component taking the owner size", async () => {
  const bundle = await loadBundle()
  const harness = makeContext()
  await bundle.apply(harness.ctx)
  const panel = harness.registrations.find((entry) => entry.name === "sidebar.panellist")
  const element = panel.result.component({ size: 18, active: false })
  assert.ok(element && element.props, "glyph renders an element")
  assert.equal(element.props.size, 18)
})

test("client: injected props expose the Host call gateway to the page", async () => {
  const bundle = await loadBundle()
  const harness = makeContext()
  await bundle.apply(harness.ctx)
  const main = harness.registrations.find((entry) => entry.name === "main")
  const injected = main.result.options.inject()
  assert.equal(typeof injected.call, "function")

  // With no Host service connected the gateway reports a recoverable error
  // instead of throwing.
  const reply = await injected.call("list", {})
  assert.equal(reply.ok, false)
  assert.match(reply.error, /未连接/)

  const prompts = await injected.call("listPrompts", {})
  assert.equal(prompts.ok, false)
})
