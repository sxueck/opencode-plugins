# Opencode-Plugins

这个项目下的插件是我在日常工作中，根据积累的 OpenCode 使用经验开发，大家可以按需取用

## 插件一览

### 1) `SessionAutoRename`（会话自动命名）

**解决的需求**
- 进入会话后经常忘记手动命名，导致历史记录难以检索。
- 首条用户问题通常已经能概括会话目标，适合作为会话标题。
- 标题希望更像“人写的摘要”：以用户首句为种子，交给模型生成标题，并对输入/输出做清洗和长度控制。

**行为说明**
- 在会话的**第 1 条用户消息**到达后：抽取该消息的**第一句话**（忽略 synthetic 文本片段，去掉代码块、`<think>`、命令/@前缀等噪音），调用 OpenAI 生成标题，然后清洗/截断并更新会话标题。
- 仅在“用户消息数等于 1”时触发，避免在后续对话中反复改名。
- 会跳过 **subagent** 派生会话（检测 `parentID`），避免干扰子任务会话。
- 触发事件以 `message.updated` / `message.part.updated` 为主；若错过消息事件，也会在会话 `idle` 时兜底尝试一次。

**OpenAI 配置文件**
- 默认读取 `~/.config/opencode/openai.jsonc`（支持 `//` 与 `/* */` 注释）。
- 最少需要 `apiKey`（也兼容 `key/openaiApiKey/OPENAI_API_KEY/openai_api_key`）。
- 可选：`baseURL`（默认 `https://api.openai.com/v1`）、`model`（默认 `gpt-4o-mini`）。

**可配置项（环境变量）**
- `OPENCODE_SESSION_AUTORENAME_ENABLED`：是否启用（默认 `true`）
- `OPENCODE_SESSION_AUTORENAME_MAX_CHARS`：标题最大长度（默认 `50`，且强制不超过 50）
- `OPENCODE_SESSION_AUTORENAME_MIN_CHARS`：触发/保留的最小长度（默认 `3`）
- `OPENCODE_SESSION_AUTORENAME_OPENAI_TIMEOUT_MS`：OpenAI 请求超时（默认 `10000`）
- `OPENCODE_SESSION_AUTORENAME_OPENAI_CONFIG`：OpenAI 配置文件路径（默认 `~/.config/opencode/openai.jsonc`）
- `OPENCODE_SESSION_AUTORENAME_LOG_ON_LOAD`：加载时写入一条日志（默认 `false`）

对应实现：`plugins/session-auto-rename.js`

---

### 2) `ToolOutputTruncator`（工具输出压缩/截断）

**解决的需求**
- 工具（尤其是 shell、测试、构建、日志）输出过长会迅速吃满上下文，影响模型决策质量，甚至导致请求失败。
- 许多工具输出存在大量重复（重复行、重复块），压缩后可显著节省 token。
- 需要在不丢失关键错误信息的前提下，优先保留“尾部信息”（错误通常在末尾），并保留少量头部上下文。

**行为说明**
- 在 `tool.execute.after` 钩子上对工具输出进行治理：
  - 默认先做重复压缩（连续重复行、连续重复块），再按阈值截断。
  - 维度包含：字符数、字节数（UTF-8）、行数。
  - 截断策略：保留一定比例的头部 + 更多尾部，并插入 `--- omitted N lines ---` 标记。
  - 会在 `output.metadata.tool_output_truncator` 写入压缩/截断元信息，便于追踪。
- 同时提供一个显式工具 `truncated_bash`：执行命令并返回“已治理”的输出（包含 `exitCode/stdout/stderr` 拼接结果）。

**可配置项（环境变量）**
- `OPENCODE_TOOL_TRUNCATE_ENABLED`：是否启用（默认 `true`）
- `OPENCODE_TOOL_TRUNCATE_MAX_CHARS`：最大字符数（默认 `120000`）
- `OPENCODE_TOOL_TRUNCATE_MAX_BYTES`：最大字节数（默认 `200000`）
- `OPENCODE_TOOL_TRUNCATE_MAX_LINES`：最大行数（默认 `800`）
- `OPENCODE_TOOL_TRUNCATE_LOG_ON_LOAD`：加载时写入一条日志（默认 `false`）

对应实现：`plugins/tool-output-truncator.js`

---

## 使用方式

本仓库只提供插件实现文件，具体加载方式取决于你的 OpenCode 版本与插件配置方式。

一般而言，你需要：
1. 将 `plugins/` 目录下的插件文件放到你的可加载路径中；
2. 在 OpenCode 的插件配置里注册对应导出（`SessionAutoRename` / `ToolOutputTruncator`）；
3. 通过环境变量按需开启/调整阈值。

---

# English Version

This repository contains a small set of practical plugins for OpenCode. The focus is to automate two common pain points in daily usage:

- Session management (make sessions easier to search and review)
- Tool output governance (keep long outputs from blowing up context)

## Plugins

### 1) `SessionAutoRename` (Automatic Session Titling)

**Problem it solves**
- Sessions are often left unnamed, making history hard to search.
- The first user message usually captures the goal of the session and works well as a title.
- Titles should feel human-friendly: use the first user sentence as a seed, generate a title via OpenAI, and sanitize/enforce length caps.

**Behavior**
- When the **first user message** arrives, the plugin extracts the **first sentence** (ignores synthetic text parts; strips code blocks, `<think>` tags, command/@ prefixes), calls OpenAI to generate a title, then cleans/truncates it and updates the session title.
- It triggers only when the total number of user messages is exactly 1, so it won’t keep renaming later.
- It skips **subagent** sessions (detected via `parentID`) to avoid interfering with child-task sessions.
- Primary triggers are `message.updated` / `message.part.updated`; if those are missed, it also attempts once when the session becomes `idle`.

**OpenAI config file**
- Default path: `~/.config/opencode/openai.jsonc` (JSONC supported via comment stripping).
- Required: `apiKey` (also accepts `key/openaiApiKey/OPENAI_API_KEY/openai_api_key`).
- Optional: `baseURL` (default `https://api.openai.com/v1`), `model` (default `gpt-4o-mini`).

**Configuration (environment variables)**
- `OPENCODE_SESSION_AUTORENAME_ENABLED` (default: `true`)
- `OPENCODE_SESSION_AUTORENAME_MAX_CHARS` (default: `50`, hard-capped at 50)
- `OPENCODE_SESSION_AUTORENAME_MIN_CHARS` (default: `3`)
- `OPENCODE_SESSION_AUTORENAME_OPENAI_TIMEOUT_MS` (default: `10000`)
- `OPENCODE_SESSION_AUTORENAME_OPENAI_CONFIG` (default: `~/.config/opencode/openai.jsonc`)
- `OPENCODE_SESSION_AUTORENAME_LOG_ON_LOAD` (default: `false`)

Implementation: `plugins/session-auto-rename.js`

---

### 2) `ToolOutputTruncator` (Tool Output Compression/Truncation)

**Problem it solves**
- Long tool outputs (shell/test/build/logs) can quickly saturate context and degrade model performance.
- Many outputs contain high redundancy (repeated lines/blocks) that can be safely compressed.
- Truncation should preserve what matters: keep more of the tail (errors often appear near the end) while retaining some head context.

**Behavior**
- Hooks into `tool.execute.after` and reduces tool output by:
  - Compressing consecutive duplicate lines and repeated blocks (by default)
  - Enforcing caps on chars, UTF-8 bytes, and line count
  - Keeping a small head + a larger tail, inserting an omission marker like `--- omitted N lines ---`
  - Attaching metadata under `output.metadata.tool_output_truncator` for traceability
- Also provides an explicit tool `truncated_bash` which executes a shell command and returns a reduced output including `exitCode/stdout/stderr`.

**Configuration (environment variables)**
- `OPENCODE_TOOL_TRUNCATE_ENABLED` (default: `true`)
- `OPENCODE_TOOL_TRUNCATE_MAX_CHARS` (default: `120000`)
- `OPENCODE_TOOL_TRUNCATE_MAX_BYTES` (default: `200000`)
- `OPENCODE_TOOL_TRUNCATE_MAX_LINES` (default: `800`)
- `OPENCODE_TOOL_TRUNCATE_LOG_ON_LOAD` (default: `false`)

Implementation: `plugins/tool-output-truncator.js`

---

## How to use

This repo only ships the plugin implementation files. The exact loading/registration steps depend on your OpenCode version and how you load plugins (config file, CLI flags, or programmatic registration).

In general:
1. Place the plugin files under a path OpenCode can load;
2. Register the exported plugin entry points (`SessionAutoRename` / `ToolOutputTruncator`);
3. Tune behavior using the environment variables above.

