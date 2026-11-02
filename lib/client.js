/**
 * dsh-memory-rules — 记忆与规则 browser half.
 *
 * One global panel (「记忆与规则」) under 「上下文洞察」 in the sidebar, and one
 * page with two tabs:
 *
 *   信念库 (beliefs, the default tab) — the 观察信念层. Background reflection can
 *     infer a belief the user disagrees with, so this tab exists to correct the
 *     wording and to delete a belief the user does not want. There is no "add"
 *     entry: beliefs are produced by consolidation, and a hand-written rule
 *     belongs in 提示词 instead.
 *   提示词 (prompts) — the ordered prompt blocks injected as the `memory-rules`
 *     system-prompt context (order 120, before the memory guidance at 150). They
 *     can be added, edited, ordered, enabled/disabled and deleted, and the
 *     collapsible 注入预览 shows the exact text that will be injected.
 *
 * Deliberate choices:
 *
 *  - the page talks to the Host through the mounted Typert Remote namespace,
 *    never to SQLite, so the database keeps one writer (the Host service);
 *  - "删除" on a belief is a real delete, and the dialog says so: the row and
 *    its `belief_revisions` go away together, and the facts that were cited as
 *    evidence stay. Nothing recovers it, so the confirmation is explicit;
 *  - every mutation is followed by a re-fetch, because the Host is the source
 *    of truth for `updated_at`, clamping, revision numbers and the injection
 *    preview (which the Host computes from the same join the injector uses);
 *  - the forms validate locally and the Host validates again, so a stale client
 *    cannot save a malformed value.
 */

window.__ModuleLoader__.load({
	id: "dsh-memory-rules",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		const React = require("react")
		const jsxRuntime = require("react/jsx-runtime")
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives")
		const { useState, useEffect, useCallback } = React
		const jsx = jsxRuntime.jsx
		const jsxs = jsxRuntime.jsxs

		const PACKAGE = "dsh-memory-rules"
		const PANEL_ID = "memory-library"
		const PANEL_LABEL = "记忆与规则"
		const PANEL_ORDER = 30
		const PAGE_SIZE = 20
		const MAX_CONTENT = 4000
		const MAX_TITLE = 80
		const MAX_BODY = 8000
		const MAX_POSITION = 1000000
		const PROMPT_ORDER = 120
		const GUIDANCE_ORDER = 150

		const TABS = [
			{ id: "beliefs", label: "信念库" },
			{ id: "prompts", label: "提示词" }
		]

		const SCOPE_OPTIONS = [
			{ id: "active", label: "未归档" },
			{ id: "archived", label: "已归档" },
			{ id: "all", label: "全部" }
		]

		// ── toast bus ──────────────────────────────────────────────────────
		// apply() runs outside React, so the page publishes and the overlay
		// component owns the Toast state.
		const toastBus = { listener: null, seq: 0 }

		function notify(text, tone) {
			toastBus.seq += 1
			const item = { text, tone, seq: toastBus.seq }
			const listener = toastBus.listener
			if (typeof listener !== "function") {
				console.warn(`[${PACKAGE}] toast listener is not mounted: ${text}`)
				return
			}
			listener(item)
		}

		function Toaster() {
			const [toast, setToast] = useState(null)
			useEffect(() => {
				toastBus.listener = setToast
				return () => {
					if (toastBus.listener === setToast) toastBus.listener = null
				}
			}, [])
			if (toast === null) return null
			return jsx(primitives.Toast, {
				text: toast.text,
				tone: toast.tone,
				holdMs: 4000,
				onDone: () => {
					setToast((current) => (current !== null && current.seq === toast.seq ? null : current))
				}
			})
		}

		// ── styles ─────────────────────────────────────────────────────────
		// A package-owned <style> tag, inserted once and removed when the
		// plugin is disposed. Class names carry the `dml-` prefix so a theme
		// or another plugin cannot collide with them (the prefix predates the
		// 记忆与规则 rename and is kept on purpose: it is not part of the API,
		// and renaming it would invalidate every screenshot and selector).
		const CSS = `
.dml-page{width:100%;min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;display:flex;overflow:hidden}
.dml-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.dml-content{max-width:1120px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.dml-heading{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));display:flex}
.dml-heading h1{margin:0;font-size:20px;font-weight:500;line-height:1.4}
.dml-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;margin:10px 0 18px}
.dml-heading-actions{display:flex;align-items:center;gap:8px}
.dml-tabs{display:inline-flex;gap:2px;margin:16px 0 0;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.dml-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;padding:7px 16px;border-radius:999px;cursor:pointer;white-space:nowrap}
.dml-tab:hover{color:var(--dsw-alias-label-primary)}
.dml-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.10)}
.dml-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 14px}
.dml-search{position:relative;display:flex;align-items:center;flex:1 1 240px;max-width:380px}
.dml-search-icon{position:absolute;left:9px;color:var(--dsw-alias-label-secondary);pointer-events:none;display:flex}
.dml-search-input{width:100%;box-sizing:border-box;height:30px;padding:0 26px 0 28px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dml-search-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dml-search-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dml-search-clear{position:absolute;right:4px;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.dml-search-clear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dml-seg{display:inline-flex;align-items:center;gap:2px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px}
.dml-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:5px 11px;border-radius:999px;cursor:pointer;white-space:nowrap}
.dml-seg button:hover{color:var(--dsw-alias-label-primary)}
.dml-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.10)}
.dml-count{color:var(--dsw-alias-label-secondary);font-size:12px;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.dml-table-scroll{overflow-x:auto}
.dml-table{min-width:840px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dml-thead,.dml-row{display:grid;grid-template-columns:minmax(240px,1fr) 96px 124px 76px 70px 70px 80px;gap:14px;align-items:center;padding:11px 16px}
.dml-thead{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dml-thead span:nth-child(n+5){text-align:right}
.dml-thead span:last-child{text-align:right}
.dml-row{border-bottom:1px solid var(--dsw-alias-border-l1);transition:background .12s ease,opacity .12s ease}
.dml-row:last-child{border-bottom:0}
.dml-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dml-row-archived{opacity:.55}
.dml-row-archived:hover{opacity:.78}
.dml-row-archived .dml-row-content{text-decoration:line-through}
.dml-row-main{min-width:0}
.dml-row-content{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;line-height:1.55;cursor:text}
.dml-row-content:hover{color:var(--dsw-alias-label-primary)}
.dml-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center}
.dml-badge{font-size:11px;line-height:1;padding:3px 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;background:transparent}
.dml-badge-belief{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, transparent)}
.dml-badge-builtin{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, transparent)}
.dml-badge-archived{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent)}
.dml-badge-disabled{color:var(--dsw-alias-label-secondary);border-style:dashed}
.dml-badge-overwritten{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);cursor:help}
.dml-badge-topic{max-width:220px;overflow:hidden;text-overflow:ellipsis}
.dml-confidence{display:flex;flex-direction:column;gap:5px;min-width:0}
.dml-confidence-value{font-variant-numeric:tabular-nums;font-size:13px;line-height:1}
.dml-bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dml-bar > i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.dml-time{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dml-layer-cell{display:flex;justify-content:flex-start}
.dml-num{font-size:13px;color:var(--dsw-alias-label-primary);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dml-num-muted{color:var(--dsw-alias-label-secondary)}
.dml-actions{display:flex;justify-content:flex-end;gap:2px}
.dml-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:56px 16px;color:var(--dsw-alias-label-secondary);text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.dml-empty h2{font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary);margin:0}
.dml-empty p{margin:0;font-size:12px;max-width:460px}
.dml-empty-glyph{opacity:.55}
.dml-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dml-loading{padding:48px 0;text-align:center;color:var(--dsw-alias-label-secondary)}
.dml-error{margin:0 0 14px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:10px 12px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);display:flex;gap:12px;align-items:center;justify-content:space-between}
.dml-error span{min-width:0;word-break:break-word}
.dml-form{display:flex;flex-direction:column;gap:16px}
.dml-field{display:flex;flex-direction:column;gap:6px}
.dml-label{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.dml-textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:132px;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.6;outline:none}
.dml-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dml-textarea[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.dml-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dml-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dml-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.dml-row2{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:start}
.dml-number{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-variant-numeric:tabular-nums;outline:none}
.dml-number:focus{border-color:var(--dsw-alias-brand-primary)}
.dml-number[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.dml-range{width:100%;accent-color:var(--dsw-alias-brand-primary);margin:2px 0 0}
.dml-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dml-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dml-stats{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dml-stats b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.dml-preview{max-height:200px;overflow:auto;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:13px;white-space:pre-wrap;word-break:break-word}
.dml-preview-archived{text-decoration:line-through;opacity:.7}
.dml-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dml-danger{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dml-prompts{display:flex;flex-direction:column;gap:8px}
.dml-prompt-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:16px;align-items:center;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dml-prompt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dml-prompt-main{min-width:0}
.dml-prompt-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dml-prompt-title{font-weight:500}
.dml-prompt-body{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
.dml-prompt-meta{display:flex;flex-direction:column;align-items:flex-end;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dml-prompt-side{display:flex;align-items:center;gap:14px}
.dml-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer}
.dml-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.dml-switch-track{width:32px;height:18px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);position:relative;transition:background .12s ease,border-color .12s ease;display:block}
.dml-switch-track > i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .12s ease,background .12s ease}
.dml-switch input:checked + .dml-switch-track{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent);border-color:var(--dsw-alias-brand-primary)}
.dml-switch input:checked + .dml-switch-track > i{transform:translateX(14px);background:var(--dsw-alias-brand-primary)}
.dml-switch input:focus-visible + .dml-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dml-preview-box{margin-top:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dml-preview-summary{padding:10px 14px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none;list-style:none}
.dml-preview-summary::-webkit-details-marker{display:none}
.dml-preview-summary:hover{color:var(--dsw-alias-label-primary)}
.dml-preview-body{padding:0 14px 14px;display:flex;flex-direction:column;gap:8px}
.dml-preview-text{margin:0;max-height:280px;overflow:auto;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:inherit;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
`

		let styleTag = null

		function ensureStyles() {
			if (typeof document === "undefined" || styleTag !== null) return
			const existing = document.querySelector('style[data-dsh-plugin="dsh-memory-rules"]')
			if (existing !== null) {
				styleTag = existing
				return
			}
			const tag = document.createElement("style")
			tag.dataset.dshPlugin = "dsh-memory-rules"
			tag.textContent = CSS
			document.head.appendChild(tag)
			styleTag = tag
		}

		function disposeStyles() {
			if (styleTag !== null && styleTag.isConnected) styleTag.remove()
			styleTag = null
		}

		// ── small helpers ──────────────────────────────────────────────────
		function formatTime(value) {
			if (typeof value !== "string" || value === "") return "—"
			const date = new Date(value)
			if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace("T", " ")
			const pad = (n) => String(n).padStart(2, "0")
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
		}

		function confidenceTone(value) {
			const n = Number(value)
			if (!Number.isFinite(n)) return "var(--dsw-alias-state-idle-primary)"
			if (n >= 0.75) return "var(--dsw-alias-state-success-primary)"
			if (n >= 0.5) return "var(--dsw-alias-brand-primary)"
			if (n >= 0.3) return "var(--dsw-alias-state-warn-primary)"
			return "var(--dsw-alias-state-error-primary)"
		}

		function confidenceText(value) {
			const n = Number(value)
			return Number.isFinite(n) ? n.toFixed(2) : "—"
		}

		function isArchived(item) {
			return item !== null && item !== undefined && typeof item.archived_at === "string" && item.archived_at !== ""
		}

		function bodyPreview(text) {
			const flat = typeof text === "string" ? text : ""
			return flat.length <= 160 ? flat : `${flat.slice(0, 160)}…`
		}

		// ── belief edit dialog ─────────────────────────────────────────────
		function BeliefEditDialog({ item, call, onClose, onSaved }) {
			const [content, setContent] = useState(item ? item.content : "")
			const [confidence, setConfidence] = useState(item ? String(item.confidence) : "0.60")
			const [error, setError] = useState(null)
			const [busy, setBusy] = useState(false)

			const trimmed = content.trim()
			const confValue = Number(confidence)
			const confValid = String(confidence).trim() !== "" && Number.isFinite(confValue) && confValue >= 0 && confValue <= 1
			const contentError = trimmed === ""
				? "信念内容不能为空"
				: trimmed.length > MAX_CONTENT
					? `信念内容不能超过 ${MAX_CONTENT} 个字符`
					: null
			const confidenceError = confValid ? null : "置信度必须是 0.00 到 1.00 之间的数字"
			const canSave = contentError === null && confidenceError === null && !busy

			const save = async () => {
				if (!canSave) return
				setBusy(true)
				setError(null)
				const reply = await call("update", { id: item.id, content: trimmed, confidence: confValue })
				setBusy(false)
				if (!reply.ok) {
					setError(reply.error)
					return
				}
				onSaved("belief-edit")
			}

			const footer = jsxs(React.Fragment, {
				children: [
					jsx(primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: () => {
							if (!busy) onClose()
						},
						children: "取消"
					}),
					jsx(primitives.Button, {
						variant: "primary",
						disabled: !canSave,
						onClick: save,
						children: busy ? "保存中…" : "保存"
					})
				]
			})

			const body = jsxs("div", {
				className: "dml-form",
				children: [
					jsxs("div", {
						className: "dml-field",
						children: [
							jsxs("label", {
								className: "dml-label",
								htmlFor: "dml-content",
								children: [
									jsx("span", { children: "信念内容" }),
									jsx("span", { children: `${trimmed.length} / ${MAX_CONTENT}` })
								]
							}),
							jsx("textarea", {
								id: "dml-content",
								className: "dml-textarea",
								autoFocus: true,
								rows: 6,
								maxLength: MAX_CONTENT,
								value: content,
								placeholder: "用一句完整的话写下你希望 Agent 相信并遵循的结论…",
								"aria-invalid": contentError !== null ? "true" : undefined,
								"aria-describedby": contentError !== null ? "dml-content-error" : undefined,
								onChange: (event) => setContent(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
										event.preventDefault()
										void save()
									}
								}
							}),
							contentError !== null
								? jsx("div", { className: "dml-err", id: "dml-content-error", role: "alert", children: contentError })
								: jsx("div", { className: "dml-hint", children: "保存时会与已有信念做去重校验。" })
						]
					}),
					jsxs("div", {
						className: "dml-row2",
						children: [
							jsxs("div", {
								className: "dml-field",
								children: [
									jsx("label", {
										className: "dml-label",
										htmlFor: "dml-confidence",
										children: jsx("span", { children: "置信度" })
									}),
									jsx("input", {
										id: "dml-confidence",
										className: "dml-number",
										type: "number",
										min: 0,
										max: 1,
										step: 0.01,
										value: confidence,
										"aria-invalid": confidenceError !== null ? "true" : undefined,
										"aria-describedby": confidenceError !== null ? "dml-confidence-error" : "dml-confidence-hint",
										onChange: (event) => setConfidence(event.target.value)
									}),
									confidenceError !== null
										? jsx("div", { className: "dml-err", id: "dml-confidence-error", role: "alert", children: confidenceError })
										: jsx("div", { className: "dml-hint", id: "dml-confidence-hint", children: "0.00 表示不确定，1.00 表示十分确定" })
								]
							}),
							jsxs("div", {
								className: "dml-field",
								children: [
									jsx("span", { className: "dml-label", children: jsx("span", { children: "强度" }) }),
									jsx("input", {
										className: "dml-range",
										type: "range",
										min: 0,
										max: 1,
										step: 0.01,
										value: confValid ? confValue : 0.6,
										"aria-label": "拖动调整置信度",
										onChange: (event) => setConfidence(event.target.value)
									}),
									jsx("div", { className: "dml-hint", children: `当前：${confValid ? confValue.toFixed(2) : "—"}` })
								]
							})
						]
					}),
					jsxs("div", {
						className: "dml-stats",
						children: [
							jsxs("span", {
								children: [jsx("b", { children: "belief" }), " 层"]
							}),
							jsxs("span", {
								children: ["证据数 ", jsx("b", { children: String(item ? item.evidence_count ?? 0 : 0) })]
							}),
							jsxs("span", {
								children: ["修订号 ", jsx("b", { children: String(item ? item.revision_number ?? 0 : 0) })]
							}),
							item && item.overwritten
								? jsx(primitives.Tooltip, {
									label: "该信念因与新事实冲突已被系统重写",
									children: jsx("span", {
										className: "dml-badge dml-badge-overwritten",
										tabIndex: 0,
										children: "已重写"
									})
								})
								: null
						]
					}),
					jsx("div", { className: "dml-hint", children: "修正后会写入 belief_revisions，并让修订号 +1。" }),
					error !== null
						? jsx("div", { className: "dml-error", role: "alert", children: jsx("span", { children: error }) })
						: null
				]
			})

			return jsx(primitives.Modal, {
				open: true,
				onClose: () => {
					if (!busy) onClose()
				},
				closeLabel: "关闭",
				title: "编辑信念",
				description: "修正偏见，使其与您的真实想法对齐。",
				footer,
				children: body
			})
		}

		// ── belief delete dialog ───────────────────────────────────────────
		function BeliefDeleteDialog({ item, call, onClose, onSaved }) {
			const [busy, setBusy] = useState(false)
			const [error, setError] = useState(null)
			const revisions = Number(item && item.revision_number) || 0

			const run = async () => {
				setBusy(true)
				setError(null)
				const reply = await call("deleteBelief", { id: item.id })
				setBusy(false)
				if (!reply.ok) {
					setError(reply.error)
					return
				}
				onSaved("belief-delete", reply.value && reply.value.item ? reply.value.item : null)
			}

			const footer = jsxs(React.Fragment, {
				children: [
					jsx(primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: () => {
							if (!busy) onClose()
						},
						children: "取消"
					}),
					jsx(primitives.Button, {
						variant: "primary",
						disabled: busy,
						onClick: run,
						children: busy ? "删除中…" : "确认删除"
					})
				]
			})

			return jsx(primitives.Modal, {
				open: true,
				onClose: () => {
					if (!busy) onClose()
				},
				closeLabel: "关闭",
				title: "删除这条信念",
				description: "删除后不可恢复。",
				footer,
				children: jsxs("div", {
					className: "dml-form",
					children: [
						jsx("div", { className: "dml-preview", children: item ? item.content : "" }),
						jsx("div", {
							className: "dml-danger",
							children: `删除后不可恢复：这条信念及其 ${revisions} 条修订记录会一并从数据库移除。`
						}),
						jsx("div", {
							className: "dml-note",
							children: "作为证据的事实（facts）不受影响，仍会参与检索；后台巩固与反思也不会再引用这条信念。"
						}),
						error !== null
							? jsx("div", { className: "dml-error", role: "alert", children: jsx("span", { children: error }) })
							: null
					]
				})
			})
		}

		// ── prompt form dialog (create / edit) ─────────────────────────────
		function PromptFormDialog({ mode, item, call, onClose, onSaved }) {
			const editing = mode === "edit"
			const [title, setTitle] = useState(editing && item ? item.title : "")
			const [body, setBody] = useState(editing && item ? item.body : "")
			const [position, setPosition] = useState(editing && item ? String(item.position) : "")
			const [enabled, setEnabled] = useState(editing && item ? item.enabled === true : true)
			const [error, setError] = useState(null)
			const [busy, setBusy] = useState(false)

			const trimmedTitle = title.trim()
			const bodyText = body.replace(/^\s+|\s+$/g, "")
			const positionText = String(position).trim()
			const positionValue = Number(positionText)
			const positionValid =
				positionText === "" ||
				(Number.isInteger(positionValue) && positionValue >= 0 && positionValue <= MAX_POSITION)

			const titleError = trimmedTitle === ""
				? "标题不能为空"
				: trimmedTitle.length > MAX_TITLE
					? `标题不能超过 ${MAX_TITLE} 个字符`
					: null
			const bodyError = bodyText === ""
				? "正文不能为空"
				: bodyText.length > MAX_BODY
					? `正文不能超过 ${MAX_BODY} 个字符`
					: null
			const positionError = positionValid ? null : `排序必须是 0 到 ${MAX_POSITION} 之间的整数`
			const canSave = titleError === null && bodyError === null && positionError === null && !busy

			const save = async () => {
				if (!canSave) return
				setBusy(true)
				setError(null)
				const payload = { title: trimmedTitle, body: bodyText, enabled }
				if (positionText !== "") payload.position = positionValue
				const reply = editing
					? await call("updatePrompt", { ...payload, id: item.id })
					: await call("createPrompt", payload)
				setBusy(false)
				if (!reply.ok) {
					setError(reply.error)
					return
				}
				onSaved(editing ? "prompt-edit" : "prompt-create")
			}

			const footer = jsxs(React.Fragment, {
				children: [
					jsx(primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: () => {
							if (!busy) onClose()
						},
						children: "取消"
					}),
					jsx(primitives.Button, {
						variant: "primary",
						disabled: !canSave,
						onClick: save,
						children: busy ? "保存中…" : "保存"
					})
				]
			})

			const body2 = jsxs("div", {
				className: "dml-form",
				children: [
					jsxs("div", {
						className: "dml-field",
						children: [
							jsx("label", {
								className: "dml-label",
								htmlFor: "dml-prompt-title",
								children: jsx("span", { children: "标题" })
							}),
							jsx("input", {
								id: "dml-prompt-title",
								className: "dml-input",
								autoFocus: true,
								maxLength: MAX_TITLE,
								value: title,
								placeholder: "例如：用户硬性协作流程",
								"aria-invalid": titleError !== null ? "true" : undefined,
								onChange: (event) => setTitle(event.target.value)
							}),
							titleError !== null
								? jsx("div", { className: "dml-err", role: "alert", children: titleError })
								: null
						]
					}),
					jsxs("div", {
						className: "dml-field",
						children: [
							jsxs("label", {
								className: "dml-label",
								htmlFor: "dml-prompt-body",
								children: [
									jsx("span", { children: "正文" }),
									jsx("span", { children: `${bodyText.length} / ${MAX_BODY}` })
								]
							}),
							jsx("textarea", {
								id: "dml-prompt-body",
								className: "dml-textarea",
								rows: 10,
								maxLength: MAX_BODY,
								value: body,
								placeholder: "这段文字会逐字进入系统提示，每轮请求都会带上。",
								"aria-invalid": bodyError !== null ? "true" : undefined,
								onChange: (event) => setBody(event.target.value)
							}),
							bodyError !== null
								? jsx("div", { className: "dml-err", role: "alert", children: bodyError })
								: jsx("div", { className: "dml-hint", children: "首尾空白会被去掉，中间的空行与缩进原样保留。" })
						]
					}),
					jsxs("div", {
						className: "dml-row2",
						children: [
							jsxs("div", {
								className: "dml-field",
								children: [
									jsx("label", {
										className: "dml-label",
										htmlFor: "dml-prompt-position",
										children: jsx("span", { children: "排序" })
									}),
									jsx("input", {
										id: "dml-prompt-position",
										className: "dml-number",
										type: "number",
										min: 0,
										max: MAX_POSITION,
										step: 1,
										value: position,
										placeholder: editing ? "" : "留空 = 排到最后",
										"aria-invalid": positionError !== null ? "true" : undefined,
										onChange: (event) => setPosition(event.target.value)
									}),
									positionError !== null
										? jsx("div", { className: "dml-err", role: "alert", children: positionError })
										: jsx("div", { className: "dml-hint", children: "数字越小越靠前。" })
								]
							}),
							jsxs("div", {
								className: "dml-field",
								children: [
									jsx("span", { className: "dml-label", children: jsx("span", { children: "启用" }) }),
									jsx("label", {
										className: "dml-switch",
										children: [
											jsx("input", {
												type: "checkbox",
												checked: enabled,
												"aria-label": "启用这条提示词",
												onChange: (event) => setEnabled(event.target.checked)
											}),
											jsx("span", { className: "dml-switch-track", children: jsx("i", {}) })
										]
									}),
									jsx("div", { className: "dml-hint", children: "停用后不进入系统提示，但仍保留在列表里。" })
								]
							})
						]
					}),
					error !== null
						? jsx("div", { className: "dml-error", role: "alert", children: jsx("span", { children: error }) })
						: null
				]
			})

			return jsx(primitives.Modal, {
				open: true,
				onClose: () => {
					if (!busy) onClose()
				},
				closeLabel: "关闭",
				title: editing ? "编辑提示词" : "新增提示词",
				description: "提示词会按排序注入系统提示（order 120，位于记忆指引之前）。",
				footer,
				children: body2
			})
		}

		// ── prompt delete dialog ───────────────────────────────────────────
		function PromptDeleteDialog({ item, call, onClose, onSaved }) {
			const [busy, setBusy] = useState(false)
			const [error, setError] = useState(null)

			const run = async () => {
				setBusy(true)
				setError(null)
				const reply = await call("deletePrompt", { id: item.id })
				setBusy(false)
				if (!reply.ok) {
					setError(reply.error)
					return
				}
				onSaved("prompt-delete")
			}

			const footer = jsxs(React.Fragment, {
				children: [
					jsx(primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: () => {
							if (!busy) onClose()
						},
						children: "取消"
					}),
					jsx(primitives.Button, {
						variant: "primary",
						disabled: busy,
						onClick: run,
						children: busy ? "删除中…" : "确认删除"
					})
				]
			})

			return jsx(primitives.Modal, {
				open: true,
				onClose: () => {
					if (!busy) onClose()
				},
				closeLabel: "关闭",
				title: "删除这条提示词",
				description: "删除后不可恢复。",
				footer,
				children: jsxs("div", {
					className: "dml-form",
					children: [
						jsx("div", { className: "dml-prompt-title", children: item ? item.title : "" }),
						jsx("div", { className: "dml-preview", children: bodyPreview(item ? item.body : "") }),
						jsx("div", {
							className: "dml-danger",
							children: "删除后不可恢复：这条提示词的正文会从数据库中移除，且没有历史版本。"
						}),
						item && item.id === "user-rules"
							? jsx("div", {
								className: "dml-note",
								children: "这是内置的硬性规则块。删除后如果没有任何启用的提示词，系统提示会自动回退到内置规则原文。"
							})
							: jsx("div", {
								className: "dml-note",
								children: "删除后下一轮请求的系统提示立即按新的列表生成。"
							}),
						error !== null
							? jsx("div", { className: "dml-error", role: "alert", children: jsx("span", { children: error }) })
							: null
					]
				})
			})
		}

		// ── the page ───────────────────────────────────────────────────────
		function MemoryRulesPage({ call }) {
			const [tab, setTab] = useState("beliefs")

			const [data, setData] = useState({
				status: "loading",
				items: [],
				total: 0,
				page: 1,
				pages: 1,
				counts: { active: 0, archived: 0 },
				error: null
			})
			const [page, setPage] = useState(1)
			const [scope, setScope] = useState("active")
			const [searchInput, setSearchInput] = useState("")
			const [query, setQuery] = useState("")
			const [reloadKey, setReloadKey] = useState(0)

			const [promptData, setPromptData] = useState({
				status: "loading",
				items: [],
				total: 0,
				enabled: 0,
				chars: 0,
				preview: null,
				error: null
			})
			const [promptReload, setPromptReload] = useState(0)

			const [dialog, setDialog] = useState(null)

			// Debounce typing so each keystroke does not become a Host round-trip.
			useEffect(() => {
				const timer = window.setTimeout(() => {
					setQuery(searchInput.trim())
					setPage(1)
				}, 250)
				return () => window.clearTimeout(timer)
			}, [searchInput])

			useEffect(() => {
				if (tab !== "beliefs") return undefined
				let cancelled = false
				setData((current) => ({
					...current,
					status: current.status === "ready" || current.status === "refreshing" ? "refreshing" : "loading",
					error: null
				}))
				Promise.resolve(call("list", { page, pageSize: PAGE_SIZE, query, scope })).then((reply) => {
					if (cancelled) return
					if (!reply.ok) {
						setData((current) => ({ ...current, status: "error", error: reply.error }))
						return
					}
					if (reply.value === null || reply.value === undefined || reply.value.kind !== "beliefs") {
						// The Host half is still the pre-2.2.0 facts service. Do not
						// render facts as beliefs and do not let a mutation write to
						// the wrong table; wait for the restart that loads the new
						// Host module.
						setData((current) => ({
							...current,
							status: "incompatible",
							items: [],
							total: 0,
							pages: 1,
							counts: { active: 0, archived: 0 },
							error: null
						}))
						return
					}
					setData({ status: "ready", error: null, ...reply.value })
					if (reply.value.page !== page) setPage(reply.value.page)
				})
				return () => {
					cancelled = true
				}
			}, [tab, page, scope, query, reloadKey])

			useEffect(() => {
				if (tab !== "prompts") return undefined
				let cancelled = false
				setPromptData((current) => ({
					...current,
					status: current.status === "ready" || current.status === "refreshing" ? "refreshing" : "loading",
					error: null
				}))
				Promise.resolve(call("listPrompts", {})).then((reply) => {
					if (cancelled) return
					if (!reply.ok) {
						setPromptData((current) => ({ ...current, status: "error", error: reply.error }))
						return
					}
					if (reply.value === null || reply.value === undefined || reply.value.kind !== "prompts") {
						setPromptData((current) => ({
							...current,
							status: "incompatible",
							items: [],
							total: 0,
							enabled: 0,
							chars: 0,
							preview: null,
							error: null
						}))
						return
					}
					setPromptData({ status: "ready", error: null, ...reply.value })
				})
				return () => {
					cancelled = true
				}
			}, [tab, promptReload])

			const reload = useCallback(() => setReloadKey((key) => key + 1), [])
			const reloadPrompts = useCallback(() => setPromptReload((key) => key + 1), [])

			const openBeliefEdit = (item) => {
				if (isArchived(item)) return
				setDialog({ kind: "belief-edit", item })
			}
			const openBeliefDelete = (item) => setDialog({ kind: "belief-delete", item })
			const openPromptCreate = () => setDialog({ kind: "prompt-create" })
			const openPromptEdit = (item) => setDialog({ kind: "prompt-edit", item })
			const openPromptDelete = (item) => setDialog({ kind: "prompt-delete", item })

			const onSaved = (kind, detail) => {
				setDialog(null)
				if (kind === "belief-edit") {
					reload()
					notify("信念已保存", "success")
					return
				}
				if (kind === "belief-delete") {
					reload()
					const removed = detail && Number(detail.deleted_revisions)
					notify(removed > 0 ? `信念已删除（含 ${removed} 条修订）` : "信念已删除", "success")
					return
				}
				reloadPrompts()
				if (kind === "prompt-create") notify("提示词已新增，下一轮请求生效", "success")
				else if (kind === "prompt-edit") notify("提示词已保存，下一轮请求生效", "success")
				else notify("提示词已删除", "success")
			}

			const togglePrompt = async (item) => {
				const reply = await call("updatePrompt", { id: item.id, enabled: item.enabled !== true })
				if (!reply.ok) {
					notify(reply.error, "error")
					return
				}
				reloadPrompts()
				notify(item.enabled ? "提示词已停用" : "提示词已启用", "success")
			}

			// ---------------------------------------------------------- heading
			const heading = jsxs("div", {
				className: "dml-heading",
				children: [
					jsx("h1", { children: PANEL_LABEL }),
					jsxs("div", {
						className: "dml-heading-actions",
						children: [
							tab === "beliefs"
								? jsx(primitives.Button, {
									variant: "outline",
									size: "sm",
									icon: jsx(primitives.IconRefreshOutlineRegular, { size: 14 }),
									disabled: data.status === "loading" || data.status === "refreshing",
									onClick: reload,
									children: "刷新"
								})
								: jsx(primitives.Button, {
									variant: "outline",
									size: "sm",
									icon: jsx(primitives.IconRefreshOutlineRegular, { size: 14 }),
									disabled: promptData.status === "loading" || promptData.status === "refreshing",
									onClick: reloadPrompts,
									children: "刷新"
								}),
							tab === "prompts"
								? jsx(primitives.Button, {
									variant: "primary",
									size: "sm",
									icon: jsx(primitives.IconPlusOutlineRegular, { size: 13 }),
									disabled: promptData.status === "incompatible",
									onClick: openPromptCreate,
									children: "新增"
								})
								: null
						]
					})
				]
			})

			const tabs = jsx("div", {
				className: "dml-tabs",
				role: "tablist",
				"aria-label": "记忆与规则分区",
				children: TABS.map((entry) => jsx("button", {
					type: "button",
					role: "tab",
					className: "dml-tab",
					"aria-selected": tab === entry.id,
					onClick: () => {
						setDialog(null)
						setTab(entry.id)
					},
					children: entry.label
				}, entry.id))
			})

			const subtitle = jsx("p", {
				className: "dml-subtitle",
				children: tab === "beliefs"
					? "观察信念层（belief）：系统巩固的结论可以在这里纠偏或删除；删除不可恢复。"
					: "提示词：按排序逐字注入系统提示（order 120，位于记忆指引之前），每轮请求都会带上。"
			})

			// ------------------------------------------------------ beliefs tab
			function beliefsBody() {
				const items = Array.isArray(data.items) ? data.items : []
				const loading = data.status === "loading"
				const refreshing = data.status === "refreshing"
				const incompatible = data.status === "incompatible"
				const counts = data.counts || { active: 0, archived: 0 }

				const toolbar = jsxs("div", {
					className: "dml-toolbar",
					children: [
						jsxs("div", {
							className: "dml-search",
							children: [
								jsx("span", { className: "dml-search-icon", children: jsx(primitives.IconSearchOutlineRegular, { size: 14 }) }),
								jsx("input", {
									className: "dml-search-input",
									type: "search",
									value: searchInput,
									placeholder: "搜索信念内容…",
									"aria-label": "搜索信念内容",
									onChange: (event) => setSearchInput(event.target.value)
								}),
								searchInput !== ""
									? jsx("button", {
										type: "button",
										className: "dml-search-clear",
										"aria-label": "清空搜索",
										onClick: () => setSearchInput(""),
										children: "×"
									})
									: null
							]
						}),
						jsx("div", {
							className: "dml-seg",
							role: "group",
							"aria-label": "按归档状态筛选",
							children: SCOPE_OPTIONS.map((option) => jsx("button", {
								type: "button",
								"aria-pressed": scope === option.id,
								onClick: () => {
									setScope(option.id)
									setPage(1)
								},
								children: option.label
							}, option.id))
						}),
						jsx("span", {
							className: "dml-count",
							children: `共 ${data.total} 条 · 未归档 ${counts.active} · 已归档 ${counts.archived}`
						})
					]
				})

				const errorBanner = data.error !== null && data.error !== undefined
					? jsxs("div", {
						className: "dml-error",
						role: "alert",
						children: [
							jsx("span", { children: `无法读取记忆与规则：${data.error}` }),
							jsx(primitives.Button, { variant: "outline", size: "sm", onClick: reload, children: "重试" })
						]
					})
					: null

				let body
				if (loading) {
					body = jsx("div", { className: "dml-loading", role: "status", children: "正在读取信念…" })
				} else if (incompatible) {
					body = jsxs("div", {
						className: "dml-empty",
						role: "status",
						children: [
							jsx(primitives.IconDatabaseOutlineRegular, { size: 26, className: "dml-empty-glyph" }),
							jsx("h2", { children: "「记忆与规则」面板需要重启后生效" }),
							jsx("p", {
								children: "已安装新的记忆与规则面板，但宿主服务仍是旧版本。请完全退出并重新打开 DSH，再回到这里。"
							}),
							jsx(primitives.Button, { variant: "outline", onClick: reload, children: "重启后重试" })
						]
					})
				} else if (items.length === 0) {
					const failed = data.status === "error"
					const filtering = query !== "" || scope !== "active"
					body = jsxs("div", {
						className: "dml-empty",
						role: "status",
						children: [
							jsx(primitives.IconDatabaseOutlineRegular, { size: 26, className: "dml-empty-glyph" }),
							jsx("h2", {
								children: failed
									? "无法读取记忆与规则"
									: filtering
										? "没有符合条件的信念"
										: "还没有信念"
							}),
							jsx("p", {
								children: failed
									? "宿主服务没有响应，重启 DSH 后再试一次。"
									: filtering
										? "换一个关键词，或切换到「全部」再试一次。"
										: "系统每 7 天会把同主题事实巩固成信念。这里只用于纠偏与清理，不提供手动添加；要让 Agent 长期遵守某条规则，请到「提示词」。"
							}),
							failed
								? jsx(primitives.Button, { variant: "outline", onClick: reload, children: "重试" })
								: null
						]
					})
				} else {
					const header = jsxs("div", {
						className: "dml-thead",
						role: "row",
						children: [
							jsx("span", { role: "columnheader", children: "记忆内容" }),
							jsx("span", { role: "columnheader", title: "0.00 – 1.00", children: "置信度" }),
							jsx("span", { role: "columnheader", children: "更新时间" }),
							jsx("span", { role: "columnheader", children: "层" }),
							jsx("span", { role: "columnheader", children: "证据数" }),
							jsx("span", { role: "columnheader", children: "修订号" }),
							jsx("span", { role: "columnheader", children: "操作" })
						]
					})

					const rows = items.map((item) => {
						const archived = isArchived(item)
						const overwritten = item.overwritten === true
						const rowClass = `dml-row${archived ? " dml-row-archived" : ""}`
						return jsxs("div", {
							className: rowClass,
							role: "row",
							children: [
								jsxs("div", {
									className: "dml-row-main",
									role: "cell",
									children: [
										jsx("div", {
											className: "dml-row-content",
											title: `${item.content}\n\n双击编辑`,
											onDoubleClick: () => openBeliefEdit(item),
											children: item.content
										}),
										jsxs("div", {
											className: "dml-meta",
											children: [
												archived
													? jsx("span", { className: "dml-badge dml-badge-archived", children: "已作废" })
													: null,
												overwritten
													? jsx(primitives.Tooltip, {
														label: "该信念因与新事实冲突已被系统重写",
														children: jsx("span", {
															className: "dml-badge dml-badge-overwritten",
															tabIndex: 0,
															children: "已重写"
														})
													})
													: null,
												typeof item.topic === "string" && item.topic !== ""
													? jsx("span", {
														className: "dml-badge dml-badge-topic",
														title: `主题：${item.topic}`,
														children: item.topic
													})
													: null
											]
										})
									]
								}),
								jsxs("div", {
									className: "dml-confidence",
									role: "cell",
									children: [
										jsx("span", { className: "dml-confidence-value", children: confidenceText(item.confidence) }),
										jsx("span", {
											className: "dml-bar",
											title: `置信度 ${confidenceText(item.confidence)}`,
											children: jsx("i", {
												style: {
													width: `${Math.round(Math.min(1, Math.max(0, Number(item.confidence) || 0)) * 100)}%`,
													background: confidenceTone(item.confidence)
												}
											})
										})
									]
								}),
								jsx("div", {
									className: "dml-time",
									role: "cell",
									title: `创建：${formatTime(item.created_at)}\n更新：${formatTime(item.updated_at)}${archived ? `\n作废：${formatTime(item.archived_at)}` : ""}`,
									children: formatTime(item.updated_at || item.created_at)
								}),
								jsx("div", {
									className: "dml-layer-cell",
									role: "cell",
									children: jsx("span", {
										className: "dml-badge dml-badge-belief",
										title: "观察信念层（belief）",
										children: "belief"
									})
								}),
								jsx("div", {
									className: "dml-num",
									role: "cell",
									title: `引用 ${Number(item.evidence_count) || 0} 条证据`,
									children: String(Number(item.evidence_count) || 0)
								}),
								jsx("div", {
									className: "dml-num dml-num-muted",
									role: "cell",
									title: `修订号 ${Number(item.revision_number) || 0}`,
									children: String(Number(item.revision_number) || 0)
								}),
								jsxs("div", {
									className: "dml-actions",
									role: "cell",
									children: [
										jsx(primitives.Tooltip, {
											label: "编辑",
											children: jsx(primitives.Button, {
												variant: "ghost",
												size: "sm",
												disabled: archived,
												icon: jsx(primitives.IconEditOutlineRegular, { size: 14 }),
												"aria-label": `编辑信念：${item.content.slice(0, 40)}`,
												onClick: () => openBeliefEdit(item)
											})
										}),
										jsx(primitives.Tooltip, {
											label: "删除",
											children: jsx(primitives.Button, {
												variant: "ghost",
												size: "sm",
												icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
												"aria-label": `删除信念：${item.content.slice(0, 40)}`,
												onClick: () => openBeliefDelete(item)
											})
										})
									]
								})
							]
						}, item.id)
					})

					const footer = jsxs("div", {
						className: "dml-footer",
						children: [
							jsx("span", {
								children: data.total === 0
									? "共 0 条"
									: `第 ${data.page} / ${data.pages} 页 · 显示第 ${(data.page - 1) * PAGE_SIZE + 1}–${Math.min(data.page * PAGE_SIZE, data.total)} 条，共 ${data.total} 条`
							}),
							jsxs("div", {
								style: { display: "flex", gap: 8 },
								children: [
									jsx(primitives.Button, {
										variant: "outline",
										size: "sm",
										disabled: data.page <= 1 || refreshing,
										onClick: () => setPage((value) => Math.max(1, value - 1)),
										children: "上一页"
									}),
									jsx(primitives.Button, {
										variant: "outline",
										size: "sm",
										disabled: data.page >= data.pages || refreshing,
										onClick: () => setPage((value) => Math.min(data.pages, value + 1)),
										children: "下一页"
									})
								]
							})
						]
					})

					body = jsxs("div", {
						"aria-busy": refreshing ? "true" : "false",
						children: [
							jsx("div", {
								className: "dml-table-scroll",
								children: jsx("div", {
									className: "dml-table",
									role: "table",
									"aria-label": "观察信念列表",
									children: [header, rows]
								})
							}),
							footer
						]
					})
				}

				return jsxs(React.Fragment, { children: [toolbar, errorBanner, body] })
			}

			// ------------------------------------------------------ prompts tab
			function promptsBody() {
				const items = Array.isArray(promptData.items) ? promptData.items : []
				const loading = promptData.status === "loading"
				const refreshing = promptData.status === "refreshing"
				const incompatible = promptData.status === "incompatible"
				const preview = promptData.preview

				const toolbar = jsxs("div", {
					className: "dml-toolbar",
					children: [
						jsx("span", {
							className: "dml-count",
							children: `共 ${promptData.total} 条 · 启用 ${promptData.enabled} 条 · 注入 ${promptData.chars} 字`
						})
					]
				})

				const errorBanner = promptData.error !== null && promptData.error !== undefined
					? jsxs("div", {
						className: "dml-error",
						role: "alert",
						children: [
							jsx("span", { children: `无法读取提示词：${promptData.error}` }),
							jsx(primitives.Button, { variant: "outline", size: "sm", onClick: reloadPrompts, children: "重试" })
						]
					})
					: null

				let body
				if (loading) {
					body = jsx("div", { className: "dml-loading", role: "status", children: "正在读取提示词…" })
				} else if (incompatible) {
					body = jsxs("div", {
						className: "dml-empty",
						role: "status",
						children: [
							jsx(primitives.IconDatabaseOutlineRegular, { size: 26, className: "dml-empty-glyph" }),
							jsx("h2", { children: "「提示词」需要重启后生效" }),
							jsx("p", {
								children: "已安装新的记忆与规则面板，但宿主服务仍是旧版本。请完全退出并重新打开 DSH，再回到这里。"
							}),
							jsx(primitives.Button, { variant: "outline", onClick: reloadPrompts, children: "重启后重试" })
						]
					})
				} else if (items.length === 0) {
					body = jsxs("div", {
						className: "dml-empty",
						role: "status",
						children: [
							jsx(primitives.IconDatabaseOutlineRegular, { size: 26, className: "dml-empty-glyph" }),
							jsx("h2", { children: "还没有提示词" }),
							jsx("p", {
								children: "新增一条提示词，它会在下一轮请求进入系统提示。全部删除或停用后，系统提示会自动回退到内置规则原文。"
							}),
							jsx(primitives.Button, { variant: "outline", onClick: openPromptCreate, children: "新增第一条提示词" })
						]
					})
				} else {
					const rows = items.map((item) => jsxs("div", {
						className: "dml-prompt-row",
						role: "listitem",
						children: [
							jsxs("div", {
								className: "dml-prompt-main",
								children: [
									jsxs("div", {
										className: "dml-prompt-head",
										children: [
											jsx("span", { className: "dml-prompt-title", children: item.title }),
											item.id === "user-rules"
												? jsx("span", { className: "dml-badge dml-badge-builtin", title: "由 dsh-user-rules 合并而来，删除后仍有内置兜底", children: "内置" })
												: null,
											item.enabled === true
												? null
												: jsx("span", { className: "dml-badge dml-badge-disabled", children: "已停用" })
										]
									}),
									jsx("div", {
										className: "dml-prompt-body",
										title: item.body,
										children: bodyPreview(item.body)
									})
								]
							}),
							jsxs("div", {
								className: "dml-prompt-meta",
								children: [
									jsx("span", { children: `顺序 ${item.position}` }),
									jsx("span", { children: `${item.chars} 字` }),
									jsx("span", { title: `创建：${formatTime(item.created_at)}`, children: `更新 ${formatTime(item.updated_at)}` })
								]
							}),
							jsxs("div", {
								className: "dml-prompt-side",
								children: [
									jsx("label", {
										className: "dml-switch",
										title: item.enabled === true ? "已启用：点击停用" : "已停用：点击启用",
										children: [
											jsx("input", {
												type: "checkbox",
												checked: item.enabled === true,
												"aria-label": `启用提示词：${item.title}`,
												onChange: () => togglePrompt(item)
											}),
											jsx("span", { className: "dml-switch-track", children: jsx("i", {}) })
										]
									}),
									jsxs("div", {
										className: "dml-actions",
										children: [
											jsx(primitives.Tooltip, {
												label: "编辑",
												children: jsx(primitives.Button, {
													variant: "ghost",
													size: "sm",
													icon: jsx(primitives.IconEditOutlineRegular, { size: 14 }),
													"aria-label": `编辑提示词：${item.title}`,
													onClick: () => openPromptEdit(item)
												})
											}),
											jsx(primitives.Tooltip, {
												label: "删除",
												children: jsx(primitives.Button, {
													variant: "ghost",
													size: "sm",
													icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
													"aria-label": `删除提示词：${item.title}`,
													onClick: () => openPromptDelete(item)
												})
											})
										]
									})
								]
							})
						]
					}, item.id))

					const list = jsxs("div", {
						className: "dml-prompts",
						role: "list",
						"aria-label": "提示词列表",
						"aria-busy": refreshing ? "true" : "false",
						children: rows
					})

					const previewBox = jsxs("details", {
						className: "dml-preview-box",
						children: [
							jsx("summary", {
								className: "dml-preview-summary",
								children: preview
									? `注入预览 · ${preview.chars} 字 · order ${preview.order}${preview.fallback ? " · 内置兜底" : ""}`
									: "注入预览"
							}),
							jsxs("div", {
								className: "dml-preview-body",
								children: [
									jsx("p", {
										className: "dml-hint",
										children: preview
											? `位置：系统提示 context「${preview.name}」，order ${preview.order}，位于记忆指引（order ${preview.memoryGuidanceOrder}）之前。` +
												(preview.fallback ? "当前没有启用的提示词，下面是内置规则原文。" : "")
											: "尚无注入内容。"
									}),
									jsx("pre", {
										className: "dml-preview-text",
										children: preview && typeof preview.text === "string" ? preview.text : ""
									})
								]
							})
						]
					})

					body = jsxs(React.Fragment, { children: [list, previewBox] })
				}

				return jsxs(React.Fragment, { children: [toolbar, errorBanner, body] })
			}

			return jsxs("section", {
				className: "dml-page",
				"aria-label": PANEL_LABEL,
				children: [
					jsx("div", {
						className: "dml-scroll",
						children: jsxs("div", {
							className: "dml-content",
							children: [heading, tabs, subtitle, tab === "beliefs" ? beliefsBody() : promptsBody()]
						})
					}),
					dialog === null
						? null
						: dialog.kind === "belief-edit"
							? jsx(BeliefEditDialog, {
								item: dialog.item,
								call,
								onClose: () => setDialog(null),
								onSaved
							})
							: dialog.kind === "belief-delete"
								? jsx(BeliefDeleteDialog, {
									item: dialog.item,
									call,
									onClose: () => setDialog(null),
									onSaved
								})
								: dialog.kind === "prompt-create"
									? jsx(PromptFormDialog, {
										mode: "create",
										call,
										onClose: () => setDialog(null),
										onSaved
									})
									: dialog.kind === "prompt-edit"
										? jsx(PromptFormDialog, {
											mode: "edit",
											item: dialog.item,
											call,
											onClose: () => setDialog(null),
											onSaved
										})
										: jsx(PromptDeleteDialog, {
											item: dialog.item,
											call,
											onClose: () => setDialog(null),
											onSaved
										})
				]
			})
		}

		// ── sidebar glyph ──────────────────────────────────────────────────
		function MemoryRulesIcon({ size }) {
			return jsx(primitives.IconDatabaseOutlineRegular, { size: typeof size === "number" ? size : 16 })
		}

		// ── Host Remote contribution ───────────────────────────────────────
		const ANY_SCHEMA = { parse: (value) => value }
		const strictCodec = (symbol) => ({
			mode: "strict",
			typeSymbol: `${PACKAGE}/typert#${symbol}`,
			schema: ANY_SCHEMA,
			create: () => ANY_SCHEMA
		})
		const descriptorFor = (method) => ({
			id: `${PACKAGE}#memoryLibrary/${method}`,
			service: "memoryLibrary",
			namespace: "memoryLibrary",
			method,
			invocation: { kind: "direct" },
			parameters: [{ name: "payload", wire: "payload", source: "json", codec: strictCodec("AnyValue") }],
			result: strictCodec("AnyResult"),
			sourceLocation: { file: `${PACKAGE}/lib/library.js`, line: 1, column: 1 }
		})

		async function apply(ctx) {
			ensureStyles()
			ctx.effect(() => () => disposeStyles(), "memory-rules: styles")

			// `create` and `archive` are intentionally absent: the 信念库 tab has
			// no add and no 作废/恢复 entry, so the Host no longer exposes those
			// write paths to the browser at all. `deleteBelief` is the only
			// destructive method, and the page calls it only from the delete
			// dialog after an explicit confirmation.
			const methods = ["list", "update", "deleteBelief", "listPrompts", "createPrompt", "updatePrompt", "deletePrompt"]
			let disposeRemote = async () => {}
			try {
				disposeRemote = await ctx.remote.$mount({
					package: PACKAGE,
					descriptors: methods.map(descriptorFor)
				})
			} catch (error) {
				console.warn(`[${PACKAGE}] memoryLibrary remote mount failed`, error)
			}

			const call = async (method, args) => {
				try {
					const service = typeof ctx.get === "function" ? ctx.get("remote.memoryLibrary") : undefined
					if (service === undefined || service === null || typeof service[method] !== "function") {
						return { ok: false, error: "记忆与规则服务未连接，请重启 DSH 后重试" }
					}
					const reply = await service[method](args)
					if (reply !== null && typeof reply === "object" && reply.ok === true) {
						return { ok: true, value: reply.value }
					}
					const detail = reply && reply.error
					return { ok: false, error: (detail && (detail.message || detail.code)) || "记忆与规则服务调用失败" }
				} catch (reason) {
					return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }
				}
			}

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "memory-rules-toast"
			}, Toaster))

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				inject: () => ({ call })
			}, (props) => jsx(MemoryRulesPage, props)))

			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: PANEL_ORDER,
				label: PANEL_LABEL
			}, MemoryRulesIcon))

			return async function cleanup() {
				try {
					await disposeRemote()
				} catch {
					// Already unmounted.
				}
			}
		}

		const inject = ["slots", "remote", "typert"]

		exports.apply = apply
		exports.inject = inject

		return module.exports
	}
})
