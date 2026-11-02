/*!
 * dsh-memory-rules — 协作流程（可编辑的提示词种子）.
 *
 * 分享构建说明：RULES 已替换为中性占位模板，不再是原作者的私有流程。
 * 原文本 sha256: 72456de9fe4d45667a421857503b7174bb5b0cf5661e87f3d77050fc764381b9
 *
 * Two consumers, one source of truth:
 *
 *   1. `service.migrate()` seeds the row `prompt_blocks.id='user-rules'` with
 *      this text on the first migration of a store (see `_seedPromptBlocks`).
 *   2. `plugin.js` falls back to this text when every prompt block is disabled
 *      or deleted, so emptying the table cannot remove the rules from the
 *      system prompt.
 */

export const RULES = `用户协作流程（占位模板 —— 首次启动自动写入，请在「记忆与规则 → 提示词」中替换为你自己的规则）：

① 动手前先给计划：步骤与产出物，确认后再执行。
② 遇到需要用户决定的分叉，立即停下提问，不要自行假设后继续。
③ 交付前先给正文草稿片段，认可后再定稿。
④ 只改动任务明确涉及的文件，范围外先问。`
