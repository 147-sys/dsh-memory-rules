/*!
 * dsh-memory-rules — 记忆与规则 page: static render smoke test.
 *
 * The shell's React is not available outside the browser, so this file carries
 * a deliberately small renderer: function components, initial state only, no
 * effects, no reconciliation. That is enough to execute the page's whole render
 * path — heading, tabs, toolbar, table row, prompt rows, the collapsible
 * 注入预览, footer and every dialog — and catch a missing variable or a
 * malformed element before it reaches the GUI.
 */

import assert from "node:assert/strict"
import test from "node:test"

/** Minimal hooks runtime: one frame per function component. */
function createHooks(seeds) {
  const stack = []
  let currentName = ""
  return {
    begin(name) {
      currentName = name || "anonymous"
      stack.push([])
    },
    end() {
      stack.pop()
    },
    useState(initial) {
      const frame = stack[stack.length - 1]
      const index = frame.length
      const seeded = seeds?.[currentName]?.[index]
      const value = seeded !== undefined ? seeded : (typeof initial === "function" ? initial() : initial)
      frame.push(value)
      return [value, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    }
  }
}

/** The bundle captured the stub React at load time, so delegation is global. */
let activeHooks = null

function attrsOf(props) {
  return Object.entries(props)
    .filter(([key, value]) => key !== "children" && value !== undefined && value !== null && value !== false
      && typeof value !== "object" && typeof value !== "function")
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(" ")
}

function renderNode(node, hooks) {
  if (node === null || node === undefined || node === false || node === true) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map((child) => renderNode(child, hooks)).join("")
  if (typeof node.type === "symbol") return renderNode(node.props?.children, hooks)
  if (typeof node.type === "function") {
    activeHooks = hooks
    hooks.begin(node.type.name || "anonymous")
    const props = node.props || {}
    let output
    try {
      output = node.type({ ...props, children: props.children })
    } finally {
      hooks.end()
    }
    return renderNode(output, hooks)
  }
  const props = node.props || {}
  const attrs = attrsOf(props)
  return `<${node.type}${attrs === "" ? "" : " " + attrs}>${renderNode(props.children, hooks)}</${node.type}>`
}

async function loadBundle() {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load: (value) => {
        definition = value
      }
    }
  }
  await import(`../lib/client.js?render=${Date.now()}${Math.random()}`)
  assert.ok(definition)

  const react = {
    useState: (initial) => activeHooks.useState(initial),
    useEffect: (...args) => activeHooks.useEffect(...args),
    useCallback: (fn) => activeHooks.useCallback(fn),
    Fragment: Symbol("Fragment"),
    createElement: () => null
  }
  const runtime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props })
  }
  // Every primitive becomes a host-ish node that keeps its accessible name and
  // renders the slots a real component would show (title, children, icon,
  // footer), so the page's markup reaches the assertions. Scalar props (such as
  // `disabled`) pass through so a state-driven attribute can be asserted.
  const stub = (props = {}) => ({
    type: "stub",
    props: {
      ...props,
      children: [props.title, props.description, props.icon, props.children, props.footer]
    }
  })
  const primitives = new Proxy({}, { get: () => stub })
  const require = (id) => {
    if (id === "react") return react
    if (id === "react/jsx-runtime") return runtime
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives
    throw new Error(`unexpected require: ${id}`)
  }
  return definition.factory(require)
}

function makeContext() {
  const registrations = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === "function") disposer()
    },
    slots: {
      inject(name, callback) {
        registrations.push({ name, result: callback() })
      },
      register(options, component) {
        return { options, component }
      }
    },
    remote: { async $mount() { return async () => {} } },
    get() {
      return undefined
    }
  }
  return { ctx, registrations }
}

const ROW = {
  id: "belief_0123456789",
  content: "用户偏好深色主题，并要求文档使用中文字体",
  confidence: 0.85,
  layer: "belief",
  evidence_count: 4,
  revision_number: 2,
  overwritten: true,
  topic: "偏好·主题",
  created_at: "2026-10-20T10:00:00+08:00",
  updated_at: "2026-10-21T11:30:00+08:00",
  archived_at: null
}

const PAGE_DATA = {
  status: "ready",
  kind: "beliefs",
  items: [ROW],
  total: 1,
  page: 1,
  pages: 1,
  counts: { active: 1, archived: 0 },
  error: null
}

const PROMPT = {
  id: "user-rules",
  title: "用户硬性协作流程",
  body: "① 任何任务先给执行计划。\n② 需要用户决定时立即发问。",
  position: 0,
  enabled: true,
  chars: 30,
  created_at: "2026-10-25T12:58:00+08:00",
  updated_at: "2026-10-25T12:58:00+08:00"
}

const PROMPTS_DATA = {
  status: "ready",
  kind: "prompts",
  items: [PROMPT],
  total: 1,
  enabled: 1,
  chars: PROMPT.chars,
  preview: {
    name: "memory-rules",
    order: 120,
    memoryGuidanceOrder: 150,
    fallback: false,
    chars: PROMPT.chars,
    text: PROMPT.body
  },
  error: null
}

/**
 * Page state is seeded by hook index: 0 tab, 1 belief list, 2 page, 3 scope,
 * 4 search input, 5 query, 6 reload key, 7 prompt list, 8 prompt reload key,
 * 9 dialog.
 */
async function pageHtml(seeds) {
  const bundle = await loadBundle()
  const { ctx, registrations } = makeContext()
  await bundle.apply(ctx)
  const main = registrations.find((entry) => entry.name === "main")
  const injected = main.result.options.inject()
  return renderNode(main.result.component(injected), createHooks(seeds))
}

test("render: the page is titled 记忆与规则 and offers both tabs", async () => {
  const html = await pageHtml({ MemoryRulesPage: { 0: "beliefs", 1: PAGE_DATA } })
  assert.match(html, /<h1>记忆与规则<\/h1>/)
  assert.match(html, /aria-label="记忆与规则"/)
  assert.match(html, /role="tablist"/)
  assert.match(html, />信念库<\/button>/)
  assert.match(html, />提示词<\/button>/)
  assert.match(html, /aria-selected="true">信念库/)
})

test("render: ready belief list shows the fields, edit and delete only", async () => {
  const html = await pageHtml({ MemoryRulesPage: { 0: "beliefs", 1: PAGE_DATA } })

  assert.match(html, /观察信念层/)
  assert.match(html, /搜索信念内容/)
  assert.match(html, new RegExp(ROW.content))
  assert.match(html, /0\.85/)
  assert.match(html, /2026-10-21 11:30/)
  assert.match(html, />belief</)
  assert.match(html, /证据数/)
  assert.match(html, /修订号/)
  assert.match(html, />4</)
  assert.match(html, />2</)
  assert.match(html, /该信念因与新事实冲突已被系统重写/)
  assert.match(html, /已重写/)

  // Row actions: edit and delete, nothing else.
  assert.match(html, /aria-label="编辑信念：/)
  assert.match(html, /aria-label="删除信念：/)
  assert.doesNotMatch(html, /作废信念/)
  assert.doesNotMatch(html, /恢复信念/)

  // No add entry anywhere: not a heading button, not a dialog trigger.
  assert.doesNotMatch(html, /添加新记忆/)
  assert.doesNotMatch(html, /添加信念/)
  assert.doesNotMatch(html, /添加第一条信念/)
})

test("render: an empty belief list has no add entry and points at 提示词", async () => {
  const html = await pageHtml({
    MemoryRulesPage: {
      0: "beliefs",
      1: { status: "ready", kind: "beliefs", items: [], total: 0, page: 1, pages: 1, counts: { active: 0, archived: 0 }, error: null }
    }
  })
  assert.match(html, /还没有信念/)
  assert.match(html, /不提供手动添加/)
  assert.match(html, /提示词/)
  assert.doesNotMatch(html, /添加第一条信念/)
})

test("render: the belief edit dialog pre-fills the row and shows its stats", async () => {
  const html = await pageHtml({
    MemoryRulesPage: { 0: "beliefs", 1: PAGE_DATA, 9: { kind: "belief-edit", item: ROW } }
  })

  assert.match(html, /编辑信念/)
  assert.match(html, /修正偏见，使其与您的真实想法对齐。/)
  assert.match(html, new RegExp(ROW.content))
  assert.match(html, /证据数/)
  assert.match(html, /修订号/)
  assert.match(html, /写入 belief_revisions/)
})

test("render: the belief delete dialog states that deletion is irreversible", async () => {
  const html = await pageHtml({
    MemoryRulesPage: { 0: "beliefs", 1: PAGE_DATA, 9: { kind: "belief-delete", item: ROW } }
  })

  assert.match(html, /删除这条信念/)
  assert.match(html, /删除后不可恢复/)
  assert.match(html, /2 条修订记录会一并从数据库移除/)
  assert.match(html, /facts/)
  assert.match(html, /确认删除/)
})

test("render: the prompts tab lists blocks and shows the injection preview", async () => {
  const html = await pageHtml({ MemoryRulesPage: { 0: "prompts", 7: PROMPTS_DATA } })

  assert.match(html, /aria-selected="true">提示词/)
  assert.match(html, /用户硬性协作流程/)
  assert.match(html, /内置/)
  assert.match(html, /顺序 0/)
  assert.match(html, /30 字/)
  assert.match(html, /aria-label="启用提示词：用户硬性协作流程"/)
  assert.match(html, /aria-label="编辑提示词：用户硬性协作流程"/)
  assert.match(html, /aria-label="删除提示词：用户硬性协作流程"/)
  assert.match(html, /注入预览 · 30 字 · order 120/)
  assert.match(html, /context「memory-rules」/)
  assert.match(html, /位于记忆指引（order 150）之前/)
  assert.match(html, new RegExp("① 任何任务先给执行计划。"))
  assert.match(html, /共 1 条 · 启用 1 条 · 注入 30 字/)
})

test("render: an empty prompts tab invites the first block and explains the fallback", async () => {
  const html = await pageHtml({
    MemoryRulesPage: {
      0: "prompts",
      7: {
        status: "ready",
        kind: "prompts",
        items: [],
        total: 0,
        enabled: 0,
        chars: 0,
        preview: { name: "memory-rules", order: 120, memoryGuidanceOrder: 150, fallback: true, chars: 210, text: "内置规则" },
        error: null
      }
    }
  })
  assert.match(html, /还没有提示词/)
  assert.match(html, /回退到内置规则原文/)
  assert.match(html, /新增第一条提示词/)
})

test("render: the prompt form offers title, body, order and the enabled switch", async () => {
  const html = await pageHtml({
    MemoryRulesPage: { 0: "prompts", 7: PROMPTS_DATA, 9: { kind: "prompt-create" } }
  })

  assert.match(html, /新增提示词/)
  assert.match(html, /按排序注入系统提示/)
  assert.match(html, /dml-prompt-title/)
  assert.match(html, /dml-prompt-body/)
  assert.match(html, /0 \/ 8000/)
  assert.match(html, /排序/)
  assert.match(html, /aria-label="启用这条提示词"/)
})

test("render: the prompt delete dialog is a second confirmation", async () => {
  const html = await pageHtml({
    MemoryRulesPage: { 0: "prompts", 7: PROMPTS_DATA, 9: { kind: "prompt-delete", item: PROMPT } }
  })

  assert.match(html, /删除这条提示词/)
  assert.match(html, /删除后不可恢复/)
  assert.match(html, /没有历史版本/)
  assert.match(html, /内置的硬性规则块/)
  assert.match(html, /确认删除/)
})

test("render: a stale host asks for a restart instead of rendering the wrong table", async () => {
  const html = await pageHtml({
    MemoryRulesPage: {
      0: "beliefs",
      1: { status: "incompatible", items: [], total: 0, page: 1, pages: 1, counts: { active: 0, archived: 0 }, error: null }
    }
  })
  assert.match(html, /重启后生效/)
  assert.match(html, /完全退出并重新打开 DSH/)
})

test("render: an archived belief is struck through, not editable, still deletable", async () => {
  const archivedRow = { ...ROW, archived_at: "2026-10-22T09:00:00+08:00" }
  const html = await pageHtml({
    MemoryRulesPage: {
      0: "beliefs",
      1: { ...PAGE_DATA, items: [archivedRow], counts: { active: 0, archived: 1 } }
    }
  })

  assert.match(html, /dml-row-archived/)
  assert.match(html, /已作废/)
  assert.match(html, /disabled="true"[^>]*aria-label="编辑信念：/)
  assert.match(html, /aria-label="删除信念：/)
})
