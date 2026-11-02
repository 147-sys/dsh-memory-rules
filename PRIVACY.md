# 隐私与安全声明

**一句话**：本插件把记忆存在本机 SQLite 里，代码里没有任何联网调用，不上传、不遥测。

## 数据存在哪里

| 内容 | 路径 | 默认 |
|---|---|---|
| 主数据库 | `$DSH_HOME/memory/memory.db`（可用 `DSH_MEMORY_DIR` / `DSH_MEMORY_DB` 覆盖） | 启用 |
| 每日 Markdown 镜像 | `$DSH_HOME/memory/YYYY-MM-DD.md` | 启用（`markdownMirror`） |
| 导出视图 | 调用 `memory_export` 时写入指定目录 | 按需 |

`memory.db` 是**未加密**的 SQLite 文件。任何能读该文件的进程/用户都能看到内容。

## 会不会离开本机

**不会。** 已核对 `lib/` 全部 18 个模块：

- 无 `fetch`、无 `node:http(s)`、无 axios、无 WebSocket；
- 语义检索用的是**本地确定性特征哈希**（FNV-1a + 字符 n-gram），不是远程 embedding 模型；
- 无遥测、无统计上报。

## 插件收集什么

默认 `captureEnabled: true`，每轮从**用户消息**中抽取结构化事实（`ingestAssistant: false`，助手消息默认不抽取）：

- 世界事实、个人经历、归纳信念、常设答案；
- 抽取由本地规则 + 摘要完成，不调用外部模型；
- 同时把用户原话片段写进每日 Markdown 镜像。

这意味着**记忆库会包含你说过的原话片段**，包括你没想到会被记下的内容。

## 注入到哪里

每轮对话开始前，按四路检索挑出少量条目，作为 `<user_long_term_memories>` 块插入系统提示。模型能看到这些内容，并可能在新会话中复述。

## 你能怎么关掉

| 目的 | 做法 |
|---|---|
| 停止写入新记忆 | 配置 `captureEnabled: false` |
| 关掉 Markdown 镜像 | 配置 `markdownMirror: false` |
| 停止注入 | 配置 `recallEnabled: false` |
| 彻底删除 | 退出 DSH，删 `$DSH_HOME/memory` |

## 已知风险

1. **明文存储**：不加密。同一台机器上的其他用户、备份软件、云同步目录都可能读到。
2. **共享 `DSH_HOME`**：多人共用同一账号/同一 home 时，记忆是共享的。
3. **模型可见**：注入的内容会进入上下文，随会话日志一并落盘。
4. **删除不可逆**：删库后无法恢复，插件不提供回收站。
5. **提示词块**：`prompt_blocks` 里的规则会逐轮注入系统提示，请只放你愿意长期生效的内容。

## 漏洞与安全问题

发现安全问题请开 issue 或直接联系仓库作者，不要在公开 issue 里贴真实记忆内容。
