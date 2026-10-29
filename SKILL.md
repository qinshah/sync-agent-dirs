---
name: sync-agent-dirs
description: 把项目里各家 AI 工具（Claude Code、Cursor、Codex、Qoder、Gemini CLI、Windsurf、Cline、Trae 等）的专有目录统一软链到 .agents 单一真源，并用 .gitignore 白名单让 git 只追踪 .agents 下的 skills/mcp/rules/commands；.agents 与这些目录内容冲突时像解决 git 冲突一样逐项询问用户取舍。Use when unifying agent config dirs, symlinking .claude/.cursor/.codex/.qoder to .agents, or setting up gitignore whitelist for agent directories.
---

# sync-agent-dirs

把散落在各家的 `<.xxx>` 目录收敛成一条 `.agents` 软链，git 只追踪 `.agents` 下的白名单内容。

## 硬规则

1. **只链接目录，不碰内容语义**。每个候选目录整体变成指向 `.agents` 的软链，所以 `<.xxx>/skills` 与 `.agents/skills` 是同一份文件。
2. **冲突必须问**。`.agents` 侧和某家目录侧同名文件内容不同时，等同于 git 合并冲突：**停下来，把差异摆给用户，逐项确认，禁止自行取舍**。
3. **`.github` 永不链接**。它是仓库目录（CI、issue 模板），不是 agent 目录；`.git`、`.agents`、`.agents-backup` 同样排除。

## 流程

在项目根目录执行，`scripts/` 指本 skill 的脚本目录。

### 1. 侦察

```bash
node <skill>/scripts/sync-agents.mjs plan --project .
```

输出每个候选目录的状态：`已链接` / `待链接` / `需合并` / `不存在` / `指向他处` / `不是目录`，并列出冲突明细与"仅一侧存在、将并入 `.agents`"的文件清单。

需要结构化结果时加 `--json`。默认只处理已存在的目录；想让尚未使用的工具也提前接上（避免它自己建真目录），加 `--create`。

### 2. 逐项确认冲突

对每一个冲突路径，先看双方内容：

```bash
node <skill>/scripts/sync-agents.mjs show .claude settings.json
```

然后**向用户报告并询问**，一次问清，不要替用户选。给每个冲突列三个选项：

| 选项 | 含义 |
|---|---|
| `agents` | 保留 `.agents` 版本，丢弃该目录里的这份（多数情况下是想要共享的那份） |
| `agent` | 用该目录里的版本覆盖 `.agents`（这份是只有该工具才更新过的最新内容） |
| `leave` | 放弃这次链接，整个目录保持原样（差异太大、需要人工逐行合并时用） |

`leave` 作用于整个目录，写在该目录的 `action` 字段。

同时提示用户注意两类"非冲突但不该共享"的文件：各家私有的 `settings.json`、`auth`/`token`、缓存和日志。它们一旦并入 `.agents` 就会被所有工具看到。这类文件建议在链接前移出，或让用户决定是否走 `.gitignore` 排除。

### 3. 落定决议

把用户的选择写成 resolutions 文件（路径任意，建议项目内 `.agents-backup/resolutions.json`，该目录已被忽略）：

```json
{
  ".claude": { "settings.json": "agents", "hooks/run.sh": "agent" },
  ".cursor": { "action": "leave" }
}
```

键是目录名，值是「相对路径 → `agents` | `agent`」。未出现在文件里的冲突项视为未决定，`apply` 会拒绝执行该目录。

### 4. 执行

```bash
node <skill>/scripts/sync-agents.mjs apply --project . --yes --resolutions <file> [--create]
```

`apply` 做的事：建好 `.agents` 与白名单子目录 → 把仅一侧存在的文件并入 `.agents` → 按决议覆盖冲突 → 原目录整体移入 `.agents-backup/<时间戳>/<目录名>` → 建立相对软链 `<.xxx> -> .agents` → 重写 `.gitignore` 白名单块。

`--yes` 是刻意留的闸门：没有用户确认不要加。

### 5. 验收

```bash
node <skill>/scripts/sync-agents.mjs status --project .
git add -A && git status --short
```

预期：`.agents/skills`、`.agents/mcp` 等白名单内容出现在待提交列表；各 `.xxx` 软链与 `.agents-backup/` 不出现。若软链被追踪，说明 `.gitignore` 里的目录名写成了带斜杠的形式（`.claude/` 只匹配目录，不匹配软链），改用 `.claude`。

## .gitignore 规则

脚本维护带标记的块，重复执行只更新块内内容，不动其他规则：

```gitignore
# >>> sync-agent-dirs >>>
.agents/*
!.agents/skills/
!.agents/skills/**
!.agents/mcp/
!.agents/mcp/**
.agents-backup/

.claude
.cursor
# ...
# <<< sync-agent-dirs <<<
```

先忽略 `.agents` 下的一切，再用 `!` 逐个放行白名单目录。默认白名单 `skills,mcp,rules,commands`，用 `--track` 调整。**不要**换成 `.??*` 这类通配，会把 `.git` 一起吞掉。

## 回滚

```bash
node <skill>/scripts/sync-agents.mjs unlink --dir .claude --project .
```

删掉软链并从最新备份恢复原目录。`unlink` 不还原 `.gitignore`，需要时手工删除标记块。

## 已知边界

- 整目录链接意味着**同名路径全工具共享**。`.claude/commands` 与 `.cursor/commands` 会指向同一份文件，而两家的命令格式（frontmatter、占位符）并不兼容。commands 类内容要么只给一家用，要么各写各的、不进 `.agents`。
- 链接前该目录里若已有工具生成的文件（如 `openspec` 往 `.qoder/skills` 写的命令），它们会并入共享树，被其他工具看到。
- 软链在 Windows 上需要开发者模式或管理员权限；团队跨平台时改用 `--copy` 式同步或不做链接。
- 运行期状态（会话、缓存、锁文件）不适合共享，遇到时用 resolutions 的 `action: leave` 放弃该目录。
