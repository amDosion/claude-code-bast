# Remote Agent Task 完成回流机制：官方 SDK 调研与本仓库改造方案

**文档目的**：以 Anthropic 官方 Claude Agent SDK 的设计原则为基准，分析本仓库 `RemoteAgentTask` 框架及其三个消费方（`/ultraplan`、`/ultrareview`、`/autofix-pr`）的完成回流机制差异，给出 `/autofix-pr` 命令的完整改造方案。

**适用读者**：维护 `src/tasks/RemoteAgentTask/`、`src/commands/autofix-pr/`、`src/commands/ultraplan.tsx`、`src/commands/review/` 这些目录的工程师，以及在做 fork-upstream 同步前需要理解远端任务生命周期的代码评审者。

**版本基线**：本仓库 `test/autofix-demo` 分支（基于 `origin/main@2bca31e5`）。Claude Agent SDK 调研基于 `docs.anthropic.com/en/docs/claude-code/sdk`（2026-05 公开版）。

---

## 摘要 (TL;DR)

1. **官方 SDK 没有公开 Task 状态机**——`SDKSession` 只暴露 `sessionId` / `prompt()` / `abort()`。状态机存在于框架内部（`AppState.tasks[taskId]`），不属于面向集成者的契约。我们仓库的 `RemoteAgentTaskState` 是对官方内部实现的准确镜像。

2. **官方完成回流统一是消息队列注入**——通过 XML `<task-notification>` 注入到本地消息流，下一个 LLM turn 自然感知。不推荐回调函数、不推荐 webhook outbound。三个命令应该都沿用这个模式。

3. **官方 Archive 语义只在主动 kill 时触发**——正常完成时**默认 keep-alive**，让 `claude.ai/code` 的 URL 成为可回查的 durable record。`ultrareview` 严格遵守这个规则；`ultraplan` 因为有 `UltraplanChoiceDialog` 让用户做明确选择，所以在选择完成后 archive。

4. **`/autofix-pr` 当前实现存在 6 个 gap**——其中 1 个是 **latent bug**（`taskId` 不一致导致 `clearActiveMonitor` guard 失效），其余 5 个是回流机制缺失。

5. **推荐改造方案**：
   - **必须修**：`taskId` 不一致 bug + `clearActiveMonitor` 自然完成路径
   - **应该补**：注册 `completionChecker` + content 提取 + 定向 enqueue（与官方/ultrareview 一致）
   - **可选**：完成选项卡 + 主动 archive（偏离官方默认，提升交互但增加维护成本）

6. **我之前两次对话里的判断错误**已在第三、四部分明确纠正：(a) `ultraplan` 不走 `finalStatus` 分支，它用 `isUltraplan` 守卫完全跳过；(b) 框架并非"完全不主动 archive"，`RemoteAgentTask.kill()` 对所有类型都 archive，`ultraplan` 在 3 个位置显式 archive。

---

## 第一部分 · Claude Agent SDK 官方设计

> 信息来源：`src/entrypoints/sdk/coreTypes.generated.ts`、`src/entrypoints/sdk/runtimeTypes.ts`、`src/entrypoints/agentSdkTypes.ts`（本仓库对官方 SDK 的反编译镜像），以及 `docs.anthropic.com/en/docs/claude-code/sdk` 公开文档。

### 1.1 SDK 的 Task / Session 抽象层级

公开 API 只有两个 surface：

```typescript
// v1 API — 单次推理
query({ prompt, options }): AsyncIterable<SDKMessage>

// v2 alpha — 可恢复会话
unstable_v2_createSession(...): Promise<SDKSession>
unstable_v2_resumeSession(sessionId, ...): Promise<SDKSession>
```

`SDKSession` 的完整签名（`runtimeTypes.ts`）：

```typescript
export interface SDKSession {
  sessionId: string
  prompt(input: string | AsyncIterable<unknown>): Promise<unknown>
  abort(): void
  [key: string]: unknown   // 允许扩展，但官方没暴露 status 属性
}
```

**关键观察**：
- 没有 `session.status`、没有 `session.subscribe()`、没有 `session.onComplete()`。
- "Task" 概念在公开 SDK 中**不存在**——它是框架内部为了管理 `query()` / `SDKSession` 生命周期的抽象，记录在 `AppState.tasks[taskId]`。
- 内部状态机（推导自 `src/Task.ts`）：

```typescript
type TaskStatus =
  | 'pending'    // 已注册，未执行
  | 'running'    // 执行中（含远端轮询中）
  | 'completed'  // 正常结束
  | 'failed'     // 错误退出
  | 'killed'     // 主动终止
```

转换规则（terminal 三态不可再变，由 `isTerminalTaskStatus()` 守卫）：

```text
pending → running  : registerTask 推入后，或 teleport 成功
running → completed: sessionStatus === 'archived' / completionChecker 返回非 null / result.subtype === 'success'
running → failed   : result.subtype !== 'success' / 超时 / session 404
running → killed   : 显式调用 task.kill()
```

**对我们的启示**：`RemoteAgentTaskState` 是 SDK 内部模型的合法扩展。但如果将来想做"跨进程状态同步"（如 autofix-pr 的 sidecar 持久化），必须自行设计序列化格式——官方没有标准 schema。

---

### 1.2 Completion Handler 模式

**官方推荐：消息队列注入（Message Queue Injection）**

完成回流路径：

```text
远端 session 完成
   → poller 检测 (sessionStatus='archived' 或 result 出现 或 completionChecker 返回值)
   → enqueuePendingNotification({ value: xmlMessage, mode: 'task-notification' })
   → XML 消息在下一个 LLM turn 由 print.ts 解析
   → 注入到对话消息流
   → 本地模型读到 task-notification，决定下一步动作
```

XML schema（已在 `RemoteAgentTask.tsx:190` 实现）：

```xml
<task-notification>
  <task-id>{taskId}</task-id>
  <tool-use-id>{toolUseId}</tool-use-id>   <!-- 可选，绑定父 AgentTool 调用 -->
  <task-type>remote_agent</task-type>
  <output-file>{outputPath}</output-file>
  <status>completed | failed | killed</status>
  <summary>Remote task "{title}" completed successfully</summary>
</task-notification>
```

SDK 流模式同步发出 `system.task_notification` 事件：

```typescript
type TaskNotificationSdkEvent = {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
}
```

**不推荐的模式**：
- 回调函数（callback interface）：不利于跨进程恢复、与 LLM 上下文不对齐
- Outbound webhook（task 完成 → 推送到外部 endpoint）：官方未提供该抽象
- SSE / WebSocket subscribe：`RemoteControlHandle` 的 WebSocket 是 claude.ai 的双向控制通道，**不是** task 状态监控

**事件驱动 vs Polling 取舍**：

| 维度 | Polling（官方默认） | SSE / Webhook |
|---|---|---|
| 依赖 | OAuth token | webhook endpoint / WS 长连接 |
| 可靠性 | 1s 轮询，无推送基础设施依赖 | 丢包需重试 + 幂等 |
| 延迟 | ~1s（可接受） | 亚秒 |
| Resume 友好 | cursor 持久化即可重连 | 必须重订阅 |
| Beta header | `anthropic-beta: ccr-byoc-2025-07-29` | N/A |

**对我们的启示**：autofix-pr 的"完成回流"如果要加，应沿用消息队列注入，不要单独加 callback interface。这与现有 `enqueueRemoteReviewNotification` 路径完全一致。

---

### 1.3 Cleanup / Archive / Dispose

**官方标准抽象：`archive`**（不是 dispose/close/delete）

```typescript
// POST /v1/sessions/{id}/archive
export async function archiveRemoteSession(sessionId: string, timeout = 10_000): Promise<void>
// 实现位于本仓库 src/utils/teleport.tsx:1328
```

行为契约：
- `archived` 是远端 session 的**终态**——被 archived 的 session 拒绝新事件
- `POST /archive` 不检查 running 状态（与 `DELETE` 不同，`DELETE` 在 RUNNING 时返回 409）
- 409 (already archived) 被当作**成功**处理（幂等）
- **Fire-and-forget**：archive 失败不阻塞本地流程，session 最终由 CCR 的 TTL reaper 清理

**触发时机的官方设计**：

| 场景 | 是否 archive | 原因 |
|---|---|---|
| 用户主动 kill / `/autofix-pr stop` | ✅ 主动 archive | 用户已表态终止，立刻释放云资源 |
| 远端自然完成（无用户审批） | ❌ keep-alive | `claude.ai/code` URL 成为 durable record，用户可回查 |
| 用户在 dialog 里做明确选择 | ✅ archive（视产品决定） | 选择本身就是显式的"我完成了" |
| 错误退出（teleport 后）| ✅ archive | 防止 30min 孤儿 session |

**对我们的启示**：
- `RemoteAgentTask.kill()` 已经正确 archive，无需改动
- 自然完成时**不应**主动 archive——这是官方明确的设计意图
- 如果要加完成选项卡（参考 ultraplan），那么用户选择后 archive 是合理的

---

### 1.4 状态查询：Polling 优先于 SSE

官方推荐 **cursor-based HTTP Polling**：

```http
GET /v1/sessions/{id}/events?after_id={cursor}

Response:
{
  data: SDKMessage[],
  has_more: boolean,
  first_id: string | null,
  last_id: string | null
}
```

Session 元数据通过 `GET /v1/sessions/{id}` 单独获取（含 `session_status`：`'idle' | 'running' | 'requires_action' | 'archived'`）。

实现细节（`teleport.tsx:723` 的 `pollRemoteSessionEvents`）：

| 参数 | 值 | 说明 |
|---|---|---|
| `POLL_INTERVAL_MS` | 1000 | 1s 固定轮询，不退避 |
| `MAX_EVENT_PAGES` | 50 | 单次轮询最多翻 50 页，防 cursor stuck |
| `STABLE_IDLE_POLLS` | 5 | 连续 5 次 idle 且无 log 增长才视为完成 |
| `REMOTE_REVIEW_TIMEOUT_MS` | 30 × 60 × 1000 | review 专用 30min 超时 |

**为什么 stableIdle 需要 5 次？**——CCR 在工具调用间隙的状态有可能短暂回到 idle（agent 在"思考下一步"）。1 次 idle 不足以判定完成，5 次连续 idle 才能可靠避开间隙误判。

---

### 1.5 Webhook / 事件驱动模式的位置

官方有"远端事件触发本地 agent"的设计，但**通过 feature flag 管控，不在公开 SDK 中暴露**：

```typescript
// launchAutofixPr.ts:302 — feature-gated, non-fatal
if (feature('KAIROS_GITHUB_WEBHOOKS')) {
  await kairosSubscribePR(owner, repo, taskId).catch(() => {})
}
```

这是 KAIROS 系统的 GitHub PR 事件订阅（"PR 有新失败 → 重启 autofix"），属于**触发端**而非**完成端**。

`ScheduledTasksHandle`（`@internal`）同样是触发端：

```typescript
export type ScheduledTasksHandle = {
  events(): AsyncGenerator<ScheduledTaskEvent>  // fire | missed
  getNextFireTime(): number | null
}
```

**官方没有"task 完成 → 推送外部 endpoint"的标准模式。**完成回流统一走消息队列注入（见 1.2）。

---

### 1.6 Permission / Approval Gate 抽象

Plan mode 这类"等待用户审批"通过下列三个分散机制组合实现，**没有统一的 `approval_gate()` API**：

1. **`sessionStatus = 'requires_action'`**：CCR API 返回的原生状态，本地 poller 读取后通过 `ultraplanPhase` 字段向 UI 暴露 `'plan_ready'` badge

2. **Control Protocol**（`@alpha`，`RemoteControlHandle`）：

```typescript
export type RemoteControlHandle = {
  sendControlRequest(req: unknown): void
  sendControlResponse(res: unknown): void
  sendControlCancelRequest(requestId: string): void
  controlRequests(): AsyncGenerator<unknown>
  permissionResponses(): AsyncGenerator<unknown>
}
```

3. **本地 `PermissionResult`**（用于 `PreToolUse` hook）：

```typescript
export type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string }
```

ultraplan 的实际实现是组合：`ExitPlanModeScanner` (本仓库 `ccrSession.ts:198`) 检测远端 assistant 消息里的 `ExitPlanModeV2Tool` tool_use + 配对的 tool_result，得到 `approved` / `teleport` / `rejected` 三类信号。这是 ultraplan-specific 的组合逻辑，**不是通用 SDK 抽象**。

**对我们的启示**：autofix-pr 不需要类似 plan gate（因为 autofix 不需要用户审批中间结果），但如果要加完成选项卡，可以用类似的"在已有消息流里检测特定 tag/事件"的模式。

---

### 1.7 Subagent / Parallel Task 完成汇聚

`AgentTool` spawn 子 agent 时，完成回流通过 `tool_use_id` 绑定到原 tool_use 请求：

```xml
<task-notification>
  <task-id>{taskId}</task-id>
  <tool-use-id>{toolUseId}</tool-use-id>   <!-- 关键：绑定到父 agent 的 tool_use -->
  <task-type>remote_agent</task-type>
  <status>completed</status>
  <summary>...</summary>
</task-notification>
```

SDK 流模式有 `task_started` / `task_notification` 事件对（bookend 模式）。

**并行子任务汇聚**：
- 没有 `Promise.all()` 风格的 SDK API
- 多个子任务各自独立回流消息，本地模型在下一个 turn 通过多条 `task-notification` 一并感知
- Hook 系统有 `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted`，可用于外部监控，但不属于 SDK 核心

**对我们的启示**：autofix-pr 单 task 场景下不涉及汇聚问题；如果未来 spawn 多个并行 review agent，本地模型在同一 turn 读取多条 notification 即可。

---

### 1.8 Token / Cost 信息回流

**`ModelUsage`**（`coreTypes.generated.ts`，session-level）：

```typescript
export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number            // ✅ 官方直接给 USD cost
  contextWindow: number
  maxOutputTokens: number
}
```

**`TaskNotification.usage`**（SDK 流模式，task-level，简化）：

```typescript
usage?: {
  total_tokens: number       // 只有 total，无 cache 拆分
  tool_uses: number
  duration_ms: number
}
// ❌ 没有 costUSD
```

**已知缺口**：
- 当前实现中，远端 task 完成的 XML `<task-notification>` **不含 usage 信息**
- 远端 token 消耗在 CCR 端记账，本地无法直接查询
- 用户问"autofix-pr 花了多少钱"，当前架构无法回答

**这是 CCR 架构的已知限制**，不是我们的实现缺陷。如果将来要解决，需要 CCR 在 archive 事件里推送 `ModelUsage`，或暴露 `GET /v1/sessions/{id}/usage`。

---

## 第二部分 · 本仓库 RemoteAgentTask 框架现状

### 2.1 状态机

```text
                     registerRemoteAgentTask()
                             │
                             ▼
                      ┌─────────────┐
                      │   running   │ ◄────────────────────────────────┐
                      └─────────────┘                                  │
                             │ poll tick (POLL_INTERVAL_MS = 1000)     │
                             ▼                                         │
            ┌────────────────────────────────────┐                     │
            │     pollRemoteSessionEvents()      │                     │
            └────────────────────────────────────┘                     │
                  │              │              │                      │
                  ▼              ▼              ▼                      │
       sessionStatus       newEvents      completionChecker            │
       == 'archived'       grows →        returns non-null             │
            │              accumLog       │                            │
            │              │              ▼                            │
            │              │       status = completed                  │
            │              │       enqueueRemoteNotification           │
            │              │       evict + removeMetadata              │
            │              ▼                                           │
            │       stableIdle check (5 consecutive idle polls,        │
            │       no log growth, hasAnyOutput == true)               │
            │              │                                           │
            │      ┌───────┴────────────────────────────────┐          │
            │      │ isRemoteReview path                    │          │
            │      │  • cachedReviewContent found           │          │
            │      │    → enqueueRemoteReviewNotification   │          │
            │      │  • stableIdle w/o tag / timedOut       │          │
            │      │    → enqueueRemoteReviewFailure        │          │
            │      │  → evict + removeMetadata              │          │
            │      └───────┬────────────────────────────────┘          │
            │              │                                           │
            │      generic path: result.subtype !== 'success'?         │
            │              │ failed │ completed                        │
            │              │ → enqueueRemoteNotification               │
            │              │ → evict + removeMetadata                  │
            │              │                                           │
            │              └────── no terminal condition ──────────────┘
            ▼
     status = completed (from archived event)
     enqueueRemoteNotification
     evict + removeMetadata

     External kill path:
     RemoteAgentTask.kill() → status = 'killed', notified = true
                            → archiveRemoteSession() (fire-and-forget)
                            → evictTaskOutput + removeMetadata
```

### 2.2 启动流程

`registerRemoteAgentTask()` (`RemoteAgentTask.tsx:468`) 步骤：

1. `generateTaskId('remote_agent')` — 生成唯一 task ID
2. `initTaskOutput(taskId)` — 提前创建磁盘 output 文件
3. 构造 `RemoteAgentTaskState`：`status: 'running'`, `pollStartedAt: Date.now()`
4. `registerTask(taskState, context.setAppState)` — 写入 `AppState.tasks` 并发出 `task_started` SDK 事件
5. `persistRemoteAgentMetadata(...)` — 写 sidecar JSON，支持 `--resume` 重连
6. `startRemoteSessionPolling(taskId, context)` — 启动 1000ms 轮询，返回 cleanup 函数

调用方传入：`remoteTaskType`、`session`、`command`、`context`、可选 `toolUseId` / `isRemoteReview` / `isUltraplan` / `isLongRunning` / `remoteTaskMetadata`。

### 2.3 轮询机制

`startRemoteSessionPolling()` (`RemoteAgentTask.tsx:625`) 关键常量：

| 常量 | 值 | 用途 |
|---|---|---|
| `POLL_INTERVAL_MS` | 1000 | 轮询间隔 |
| `REMOTE_REVIEW_TIMEOUT_MS` | 30 × 60 × 1000 | 仅 `isRemoteReview` 启用 |
| `STABLE_IDLE_POLLS` | 5 | 连续 idle 计数阈值 |

每 tick 行为：
- `pollRemoteSessionEvents(task.sessionId, lastEventId)` 拉取增量事件
- `appendTaskOutput()` 把新文本追加到磁盘
- 仅在 `logGrew` 时重新提取 `todoList`（避免每秒 findLast + safeParse）
- 仅在 `isRemoteReview && logGrew && cachedReviewContent === null` 时调 `extractReviewTagFromLog`（避免每秒解析 review tag）

### 2.4 完成分支

**Branch A：远端 session archived**（`RemoteAgentTask.tsx:677-685`）
- 触发条件：`response.sessionStatus === 'archived'`
- 行为：status=completed → `enqueueRemoteNotification` → evict

**Branch B：completionChecker 返回值**（`RemoteAgentTask.tsx:687-699`）
- 触发条件：注册了 `completionChecker` 且返回非 null 字符串
- 行为：status=completed → `enqueueRemoteNotification`（带 checker 返回的字符串）→ evict

**Branch C：result 消息**（`RemoteAgentTask.tsx:705-706`）
- 触发条件：`accumulatedLog.findLast(msg => msg.type === 'result')` 找到
- **关键守卫**：`task.isUltraplan || task.isLongRunning` 时跳过——这就是 ultraplan / autofix-pr 不走 finalStatus 分支的原因
- 行为：进入 line 838-879 的 terminal 分支处理

**Branch D：stableIdle 完成**（`RemoteAgentTask.tsx:838-879`）
- 触发条件：5 次连续 idle + log 无增长 + hasAnyOutput
- 子分支 D-1（`isRemoteReview`）：
  - 提取 `cachedReviewContent ?? extractReviewFromLog(accumulatedLog)`
  - 有内容：`enqueueRemoteReviewNotification` + evict（**不 archive**，注释 line 844-846 明确）
  - 无内容：`enqueueRemoteReviewFailureNotification` + evict
- 子分支 D-2（通用）：
  - `enqueueRemoteNotification(taskId, task.title, finalStatus, ...)` + evict

### 2.5 Kill 路径

`RemoteAgentTask.kill()` (`RemoteAgentTask.tsx:936`)：

```typescript
// 步骤
1. 原子设置 status='killed', notified=true
2. emitTaskTerminatedSdk(taskId, 'stopped', {...})
3. archiveRemoteSession(sessionId)  // 主动回收云资源
4. evictTaskOutput(taskId)
5. removeRemoteAgentMetadata(taskId)
```

**这是框架中唯一主动调用 `archiveRemoteSession` 的位置**。其他位置的 archive 都在各命令的业务代码里（ultraplan 在 3 处显式 archive，见 3.1）。

---

## 第三部分 · 三命令实现对比

### 3.1 ultraplan（完整闭环范例）

**启动**：`launchDetached()` (`ultraplan.tsx:322`)

```typescript
teleportToRemote({
  initialMessage: prompt,
  description: blurb || 'Refine local plan',
  permissionMode: 'plan',
  ultraplan: true,
  signal,
  useDefaultEnvironment: true,
  // 无 environmentId 覆盖、无 skipBundle
})

registerRemoteAgentTask({
  remoteTaskType: 'ultraplan',
  session: { id, title },
  command,
  context,
  isUltraplan: true,   // ← 关键 flag
})
```

**轮询**：两个并发 poller

| Poller | 来源 | 用途 |
|---|---|---|
| 标准 `startRemoteSessionPolling` | `registerRemoteAgentTask` 内部 | 仅填充 `task.log` 供 detail view |
| 自定义 `startDetachedPoll` | `ultraplan.tsx:87` | 拥有权威完成逻辑 |

**关键守卫**：`RemoteAgentTask.tsx:705-706` 的 `isUltraplan` 让标准 poller **不会**因为 `result` 消息把 task 标记 completed。这是 ultraplan 完全绕开 framework finalStatus 分支的机制。

**完成事件检测**：`ExitPlanModeScanner.ingest()` (`ccrSession.ts:198`)

检测每批新事件中的 `ExitPlanModeV2Tool` tool_use + 配对 tool_result，三种结果：
- `approved` (is_error=false) → 提取 plan
- `teleport` (is_error=true + sentinel) → 提取 teleport plan
- `rejected` (is_error=true, 无 sentinel) → 继续轮询

`result(success)` 消息在 scanner 中**显式忽略**——只有错误 subtype 视为 session 终止。

**内容提取**：
- `extractApprovedPlan()` (`ccrSession.ts:332`)：从 `## Approved Plan:\n` 或 `## Approved Plan (edited by user):\n` 后切片
- `extractTeleportPlan()` (`ccrSession.ts:321`)：从 `ULTRAPLAN_TELEPORT_SENTINEL\n` 后切片

**回流入口**：根据 `executionTarget` 分流

`executionTarget === 'remote'`（用户在 web 里选了"在 CCR 执行"）：
```typescript
// ultraplan.tsx:117-136
updateTaskState(taskId, setAppState, t => ({ ...t, status: 'completed' }))
setAppState(prev => ({ ...prev, ultraplanSessionUrl: undefined }))
enqueuePendingNotification({
  value: 'Ultraplan approved — executing in Claude Code on the web. Follow along at: ${url}',
  mode: 'task-notification',
})
// ⚠️ 不 archive — session 正在跑代码
```

`executionTarget === 'local'`（teleport 回本地）：
```typescript
// ultraplan.tsx:137-150
setAppState(prev => ({
  ...prev,
  ultraplanPendingChoice: { plan, sessionId, taskId },
}))
// → REPL 检测到 ultraplanPendingChoice 后挂载 UltraplanChoiceDialog
```

**用户交互**：`UltraplanChoiceDialog` 三个选项

| 选项 | 行为 |
|---|---|
| Implement here | 注入 `<ultraplan>{plan}</ultraplan>` 到消息流（`UltraplanChoiceDialog.tsx:110-121`） |
| Start new session | clear conversation + plan 作为新 prompt（mode: `'prompt'`，line 148-151） |
| Cancel | 写到 `{date}-ultraplan.md`（line 154-159） |

三个选项共同收尾（`UltraplanChoiceDialog.tsx:165-177`）：

```typescript
updateTaskState(taskId, setAppState, t => ({ ...t, status: 'completed' }))
setAppState(prev => ({
  ...prev,
  ultraplanPendingChoice: undefined,
  ultraplanSessionUrl: undefined,
}))
archiveRemoteSession(sessionId)   // ⚠️ 注意：无 await/void/.catch — 浮空 Promise
```

**Archive 触发位置（3 处）**：

| 位置 | 触发条件 |
|---|---|
| `UltraplanChoiceDialog.tsx:177` | 用户选完任意选项 |
| `ultraplan.tsx:171` | `startDetachedPoll` 的 catch 块（错误退出） |
| `ultraplan.tsx:423` | `registerCleanup` 注册的进程退出 safety net |

### 3.2 ultrareview（半闭环：内容回流但 keep-alive）

**启动**：`launchRemoteReview()` (`reviewRemote.ts:129`)

```typescript
teleportToRemote({
  initialMessage: prompt,
  environmentId: 'env_011111111111111111111113',   // 合成 code_review 环境
  environmentVariables: { BUGHUNTER_*: ... },
  // PR 模式: branchName: 'refs/pull/<n>/head', useBundle: false
  // 分支模式: useBundle: true, BUGHUNTER_BASE_BRANCH: '<merge-base-sha>'
})

registerRemoteAgentTask({
  remoteTaskType: 'remote-review',
  session: { id, title },
  command,
  context,
  isRemoteReview: true,   // ← 关键 flag
})
```

**轮询**：仅标准 `startRemoteSessionPolling`，无自定义 poller。

**完成事件检测**：

```typescript
// RemoteAgentTask.tsx:715-716 (每 tick)
if (task.isRemoteReview && logGrew && cachedReviewContent === null) {
  cachedReviewContent = extractReviewTagFromLog(response.newEvents)
}
```

仅扫 `<remote-review>` tag（不带 untagged text fallback），防止早期未带 tag 的 turn 被误判完成。

完成路径：
- `cachedReviewContent !== null` + stableIdle → 内容回流
- stableIdle 但无 tag → `enqueueRemoteReviewFailureNotification`
- 30min 超时 → 同上

**内容提取**：
- `extractReviewTagFromLog()` (`RemoteAgentTask.tsx:353`)：扫 `hook_progress` / `hook_response` stdout，提取 `<remote-review>...</remote-review>`
- `extractReviewFromLog()` (`RemoteAgentTask.tsx:291`)：含 untagged text fallback，仅 stableIdle 路径使用

**回流入口**：`enqueueRemoteReviewNotification(taskId, reviewContent, setAppState)` (`RemoteAgentTask.tsx:394`)

注释（line 844-846）明确说明设计意图：

> "For remote-review tasks: inject the review text directly into the message queue. **No mode change, no file indirection — the local model just sees the review appear as a task-notification on its next turn.** Session kept alive — run_hunt.sh's post_stage() has already written the formatted findings as an assistant event, so the **claude.ai URL stays a durable record** the user can revisit. TTL handles cleanup."

**用户交互**：无对话框。review 文本作为 task-notification 出现，本地模型下一回合读到后向用户汇报。

**Archive 时机**：**从不调用**（line 844-846 注释明确说明这是 intentional omission）。

### 3.3 autofix-pr（缺闭环：要改造的对象）

**启动**：`callAutofixPr()` (`launchAutofixPr.ts:43`)

```typescript
teleportToRemote({
  initialMessage,
  description: `Autofix PR #${prNumber}`,
  skipBundle: true,
  githubPr: { owner, repo, number: prNumber },
  source: 'autofix_pr',
  useDefaultEnvironment: true,
  branchName: `refs/pull/${prNumber}/head`,
})

registerRemoteAgentTask({
  remoteTaskType: 'autofix-pr',
  session: { id, title },
  command,
  context,
  isLongRunning: true,           // ← 关键 flag
  remoteTaskMetadata: { owner, repo, prNumber },
})
```

**轮询**：仅标准 `startRemoteSessionPolling`，无自定义 poller。

**`isLongRunning` 守卫的作用**（`RemoteAgentTask.tsx:705-706`）：

```typescript
const result =
  task.isUltraplan || task.isLongRunning
    ? undefined
    : accumulatedLog.findLast(msg => msg.type === 'result')
```

与 ultraplan 一样跳过 `result` 完成路径——但 **autofix-pr 没有任何 secondary poller 来 resolve 它**。所以 autofix-pr 的 task **永远走不到自然完成**，除非 CCR session 自己 archive（Branch A，1000ms 轮询里 sessionStatus === 'archived'）。

**完成事件检测**：仅依赖 Branch A（远端 session 自然 archive）。

**内容提取**：**无**。没有 `extractAutofixResultFromLog` 之类的函数。

**回流入口**：仅 `enqueueRemoteNotification(taskId, task.title, finalStatus, ...)`（`RemoteAgentTask.tsx:190`）——只发"完成了"通知 + 一个 output 文件路径。本地模型读到后只能告诉用户"任务完成，详见 {path}"，没有任何 PR 特定的信息（修了什么、push 了什么 commit）。

**用户交互**：仅启动时的 `AutofixProgress`（`AutofixProgress.tsx`）——这是个**静态 React 元素**，rendered once with `phase: 'done'`。framework 的 `task.status` / `task.todoList` 变化**不会**回流更新它。

**Archive 时机**：**自然完成时从不调用**。只在 `RemoteAgentTask.kill()` 路径 archive（用户 `/autofix-pr stop` 或 `TaskStopTool`）。`/autofix-pr stop` 子命令调 `clearActiveMonitor()` 但不调 `archiveRemoteSession`（依赖 `RemoteAgentTask.kill()` 内部的 archive）。

### 3.4 横向对比表

| 维度 | ultraplan | ultrareview | autofix-pr |
|---|---|---|---|
| **teleport 关键 flag** | `permissionMode:'plan'`, `ultraplan:true`, `useDefaultEnvironment:true` | `environmentId:'env_01...'`, `useBundle:T/F`, `branchName:refs/pull/N/head` | `skipBundle:true`, `githubPr:{...}`, `source:'autofix_pr'`, `useDefaultEnvironment:true`, `branchName:refs/pull/N/head` |
| **register 关键 flag** | `isUltraplan:true` | `isRemoteReview:true` | `isLongRunning:true`, `remoteTaskMetadata` |
| **secondary poller** | `startDetachedPoll` → `pollForApprovedExitPlanMode`（3000ms） | 无 | **无** |
| **result 消息跳过** | ✅（`isUltraplan` 守卫） | ❌（用 stableIdle） | ✅（`isLongRunning` 守卫） |
| **完成信号** | `ExitPlanMode` tool_result 或 teleport sentinel | `<remote-review>` tag 或 stableIdle 或 30min | **仅** `sessionStatus:'archived'` |
| **content tag** | `## Approved Plan:\n` in tool_result | `<remote-review>...</remote-review>` in hook stdout | **无** |
| **enqueue 函数** | `enqueuePendingNotification`（内联文本） | `enqueueRemoteReviewNotification`（内联 review 文本） | `enqueueRemoteNotification`（仅 file path，archived 时才触发） |
| **完成 UI** | `UltraplanChoiceDialog`（3 选项） | 无（文本进消息流） | **无**（仅启动时 `AutofixProgress`） |
| **自然完成 archive** | ✅（teleport 路径在 ChoiceDialog:177 + 错误路径在 ultraplan.tsx:171） | ❌（intentional） | **❌** |
| **kill archive** | ✅（`RemoteAgentTask.kill()`） | ✅（同上） | ✅（同上） |

---

## 第四部分 · autofix-pr 当前实现的具体缺口

### Gap 1：未注册 `completionChecker`

**位置**：`launchAutofixPr.ts` 中应该在 `registerRemoteAgentTask()` 调用前后注册 `'autofix-pr'` 的 completion checker，目前未注册。

**API**：`registerCompletionChecker(remoteTaskType, checker)` (`RemoteAgentTask.tsx:113`)

**影响**：autofix-pr 完成的唯一信号是 `sessionStatus === 'archived'`（Branch A）。这意味着：
- CCR 必须主动 archive 自己（不确定 timing）
- 完成通知只能携带 generic title，不能携带"修了 N 个文件，push 了 commit X"的具体信息

**应该参考**：ultraplan 的 `startDetachedPoll` + `pollForApprovedExitPlanMode` 模式（但更简单——只需要查 PR head commit 是否变化）。

### Gap 2：缺 content 提取函数

**位置**：本仓库缺少 `extractAutofixResultFromLog(log: SDKMessage[]): string | null` 函数。

**应该参考**：
- `extractReviewFromLog` (`RemoteAgentTask.tsx:291`)
- `extractReviewTagFromLog` (`RemoteAgentTask.tsx:353`)
- `extractPlanFromLog` (`RemoteAgentTask.tsx:236`)

**XML schema 建议**：

```xml
<autofix-result>
  <pr-number>12</pr-number>
  <commits-pushed>
    <commit sha="0fb00452">fix: 修复 autofix-demo 测试的类型错误</commit>
    <commit sha="5e26e63c">fix: 应用 Biome 格式化规则</commit>
  </commits-pushed>
  <files-changed>
    <file path="src/utils/__tests__/autofix-demo.test.ts">2 changes</file>
  </files-changed>
  <ci-status>green</ci-status>
  <summary>Fixed typecheck error and biome formatting on 1 file. CI passing.</summary>
</autofix-result>
```

需要让远端 agent 在完成时输出这个 tag（通过 system prompt 约束）。

### Gap 3：缺定向 content 回流

**位置**：当前只在 `RemoteAgentTask.tsx:190` 的 `enqueueRemoteNotification` 处理 autofix-pr 完成——发的是 generic 模板。

**应该新增**：`enqueueAutofixResultNotification(taskId, autofixContent, setAppState)`，参考 `enqueueRemoteReviewNotification` (`RemoteAgentTask.tsx:394`)。

或者直接复用 `enqueuePendingNotification` + 自定义 XML 内联：

```typescript
enqueuePendingNotification({
  value: [
    '<autofix-result>',
    `  <pr-number>${prNumber}</pr-number>`,
    `  <ci-status>${ciStatus}</ci-status>`,
    `  <summary>${summary}</summary>`,
    '</autofix-result>',
    '',
    'autofix-pr completed. Summarize the changes for the user.',
  ].join('\n'),
  mode: 'task-notification',
})
```

### Gap 4：`clearActiveMonitor` 在自然完成路径未触发（**latent bug**）

**位置**：`monitorState.ts:42` 的 `clearActiveMonitor()` 仅在 `/autofix-pr stop` 调用，在 CCR 自然 archive 后**永不触发**。

**影响**：

```text
用户跑 /autofix-pr 12 → singleton lock 被设
CCR session 自然 archive → enqueueRemoteNotification 发完成通知
监控状态在 monitorState 中仍记着 active monitor
用户跑 /autofix-pr 14 → "already monitoring PR #12, run /autofix-pr stop first"
```

**用户体验上的表现**：本会话之前就遇到过 "already monitoring claude-code-bast#1237. Run /autofix-pr stop first" 错误。

**修复位置**：在 `'autofix-pr'` 的 completionChecker 回调里，或者通过 framework 暴露 `onCompleted` hook。

### Gap 5：自然完成时未 archive（**设计决策**，非 bug）

**位置**：autofix-pr 完成后云端 session 保持 alive 直到 CCR TTL 回收。

**对比 ultrareview**：ultrareview 也是 keep-alive，但有明确理由（durable record 让用户回查 review）。autofix-pr 的产出在 PR commits 里，云端 URL 价值较低。

**两种合理设计**：
- A：保持 keep-alive（与 ultrareview 一致）—— 用户可在 claude.ai/code 看 agent 完整 trace
- B：完成后 archive（节省云资源）—— 但失去 trace

**推荐**：暂时保持 A（与 ultrareview 一致，最小改动）。如果未来加完成选项卡，由用户选择是否 archive。

### Gap 6：`AutofixProgress` 是静态快照

**位置**：`AutofixProgress.tsx` 在 launch 时用 `phase: 'done'` 渲染一次，之后不更新。

**对比**：
- ultraplan 通过 `task.ultraplanPhase` 字段驱动 UI 显示 `'plan_ready'` badge
- ultrareview 通过 `task.reviewProgress` 字段驱动进度显示

**autofix-pr 应该有的字段**：
```typescript
type AutofixPhase =
  | 'analyzing'      // 远端 agent 在读 PR / 跑 CI
  | 'fixing'         // 在改代码
  | 'pushing'        // 在 push commit
  | 'waiting_ci'     // 等 CI rerun
  | 'completed'      // CI 绿了
```

但实现"实时更新"需要 framework 把 `task.todoList` 或 hook progress 转译成 phase——这是相对大的改动。

**优先级建议**：低。AutofixProgress 现状是"启动时一次性显示"，作用是告知用户 pipeline 已启动；live progress 在 background task pill 里已经有展示。这个 gap 可后续单独开 PR。

### Bug 7：`inProcessAgent.ts` 的 `taskId` 与 framework 不一致

**位置**：
- `createAutofixTeammate()` (`inProcessAgent.ts:28`) 生成自己的 `randomUUID()` 作为 `taskId`，存到 `MonitorState`
- `registerRemoteAgentTask()` (`RemoteAgentTask.tsx:494`) 通过 `generateTaskId('remote_agent')` 生成**另一个** task ID

**影响**：

```typescript
// 期望的调用模式
clearActiveMonitor(frameworkTaskId)
// → 内部 guard: active.taskId !== frameworkTaskId
// → guard 失败（active.taskId 是 teammate UUID，不是 framework taskId）
// → clearActiveMonitor 不会真正清除 lock
```

这意味着即使我们在 framework 的 completion 回调里调用 `clearActiveMonitor(taskId)`，lock 也清不掉——除非传 teammate UUID，但 framework 的 completion callback 不知道 teammate UUID。

**修复方向**（二选一）：
- A：`registerRemoteAgentTask` 返回 framework taskId → `callAutofixPr` 把这个 ID 写回 `MonitorState`，覆盖 teammate UUID
- B：`createAutofixTeammate` 接受 framework taskId 作为参数，不再自己生成

**推荐**：方向 A，改动范围小，不破坏 inProcessAgent 接口。

---

## 第五部分 · 改造方案

### 5.1 设计哲学

依据第一部分的 SDK 调研，本仓库的改造**应该尽量与官方对齐**：

| 设计取舍 | 官方做法 | 本仓库 |
|---|---|---|
| Completion 回流 | 消息队列注入 | ✅ 已有 `enqueuePendingNotification` |
| Archive 时机 | kill 时回收，自然完成 keep-alive | ✅ kill 路径正确 |
| 状态查询 | 1s cursor polling | ✅ 已有 |
| Webhook | 触发端有，完成端无 | ✅ KAIROS 仅做触发 |
| Approval gate | 组合实现，非统一 API | ✅ ultraplan 是组合实现 |
| Cost 回流 | 远端无标准 schema | ⚠️ 已知缺口 |

**结论**：autofix-pr 的改造**不需要引入官方 SDK 之外的新模式**，只需要补全缺失的实现细节。

### 5.2 三种方案对比

#### 方案 A：最小修复（与官方对齐，必做）

**范围**：
- 修 Bug 7（taskId 不一致）
- 修 Gap 4（clearActiveMonitor 自然完成路径）
- 注册 Gap 1（completionChecker，检查 PR head commit）

**保留**：
- 自然完成 keep-alive（与 ultrareview 一致）
- 不加完成 dialog
- 不加 content 提取

**预期工作量**：约 100-150 行代码改动 + 测试。

**问题**：用户看到的完成通知仍然是 generic "task completed"，不知道修了什么。

#### 方案 B：完整闭环（参考 ultraplan）

**范围**：方案 A + 以下：
- 实现 Gap 2（`extractAutofixResultFromLog`）
- 实现 Gap 3（自定义 enqueue with content）
- 实现 `AutofixCompletionDialog`（4 选项：View diff / Close PR / Keep watching / Stop monitoring）
- 完成 dialog 选择后 archive（参考 `UltraplanChoiceDialog.tsx:177`）

**新增**：
- 修改 autofix-pr 的 system prompt 让远端 agent 在完成时输出 `<autofix-result>` tag
- 新 React 组件 `AutofixCompletionDialog.tsx`
- 新增 AppState 字段 `autofixPendingChoice`
- REPL 检测 `autofixPendingChoice` 并挂载 dialog

**预期工作量**：约 600-900 行代码改动 + 测试。

**优势**：完整闭环，UX 与 ultraplan 对齐。

#### 方案 C（推荐）：方案 A + 内容回流（不带 dialog）

**范围**：方案 A + 以下：
- 实现 Gap 2（`extractAutofixResultFromLog`）
- 实现 Gap 3（`enqueueAutofixResultNotification`）
- **不**加 dialog——内容直接进消息流，本地模型读到后向用户汇报
- 保持 keep-alive（与 ultrareview 一致）

**新增**：
- 修改 autofix-pr 的 system prompt 让远端输出 `<autofix-result>` tag
- 新增 `extractAutofixResultFromLog` 函数
- 新增 `enqueueAutofixResultNotification`（或直接复用 `enqueuePendingNotification`）

**预期工作量**：约 250-400 行代码改动 + 测试。

**优势**：
- 与官方推荐模式完全一致（消息队列注入 + keep-alive）
- 与 ultrareview 设计对齐（最小新概念引入）
- 用户体验上：完成时本地模型会读到具体修了什么，可以告诉用户"修了 typecheck error，push 了 2 commits，CI 绿了"
- 不需要新 dialog，REPL 改动最小

**劣势**：
- 没有 dialog 意味着用户没有"选择关 PR"这类直接动作——但这本来就该是用户主动决定，不应该用 dialog 强制

**推荐理由**：方案 C 在改动量和价值之间取得最佳平衡。方案 B 的 dialog 偏向产品交互改进，可以作为下一轮迭代。

---

### 5.3 方案 C 详细实施步骤

#### Step 1: 修 Bug 7（taskId 不一致）

文件：`src/commands/autofix-pr/launchAutofixPr.ts` + `src/commands/autofix-pr/monitorState.ts`

修改前 `callAutofixPr` 流程：
```text
1. createAutofixTeammate() 生成 teammate UUID
2. setActiveMonitor({ taskId: teammateUUID, ... })
3. teleportToRemote(...)
4. registerRemoteAgentTask(...) 生成 frameworkTaskId
   ↑ 此时 monitorState 中的 taskId 还是 teammateUUID
```

修改后流程：
```text
1. createAutofixTeammate() 生成 teammate UUID
2. setActiveMonitor({ taskId: teammateUUID, ... })
3. teleportToRemote(...)
4. const { taskId: frameworkTaskId } = registerRemoteAgentTask(...)
5. updateActiveMonitor({ taskId: frameworkTaskId })   // ← 新增
```

需要在 `monitorState.ts` 暴露 `updateActiveMonitor(partial)` 函数。

#### Step 2: 注册 completionChecker

文件：`src/commands/autofix-pr/launchAutofixPr.ts`

```typescript
import { registerCompletionChecker } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js'

async function checkAutofixCompletion(
  task: RemoteAgentTaskState,
): Promise<string | null> {
  const meta = task.remoteTaskMetadata
  if (!meta || typeof meta !== 'object') return null
  const { owner, repo, prNumber } = meta as { owner: string; repo: string; prNumber: number }

  // 查 PR head commit + CI status
  const checkResult = await checkPrAutofixOutcome(owner, repo, prNumber, {
    initialHeadSha: meta.initialHeadSha,
    timeout: 5000,
  })

  if (!checkResult.completed) return null

  // 返回 completion message,framework 会用它作为 enqueueRemoteNotification 的 content
  return `Autofix completed on ${owner}/${repo}#${prNumber}: ${checkResult.summary}`
}

// 在 callAutofixPr 的开头注册(进程级一次性):
registerCompletionChecker('autofix-pr', checkAutofixCompletion)
```

`checkPrAutofixOutcome` 是新函数，逻辑：
1. `gh pr view {n} --repo {owner}/{repo} --json headRefOid,statusCheckRollup` 检查 head commit 是否变化 + CI 状态
2. 如果 head SHA 变了（agent push 了）+ CI 全绿 → `{ completed: true, summary: 'Fixed X files, CI green' }`
3. 如果 head SHA 没变 但 PR 关闭了 → `{ completed: true, summary: 'PR closed without fix' }`
4. 否则 → `{ completed: false }`

#### Step 3: 添加 `extractAutofixResultFromLog`

文件：`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`（新增函数）+ `src/commands/autofix-pr/extractAutofixResult.ts`

```typescript
// extractAutofixResult.ts
import type { SDKMessage } from 'src/types/sdk.js'
import { extractTag } from 'src/utils/messages.js'

export const AUTOFIX_RESULT_TAG = 'autofix-result'

export function extractAutofixResultFromLog(log: SDKMessage[]): string | null {
  // 仿 extractReviewTagFromLog 的实现:
  // 1. 扫 hook_progress/hook_response stdout 找 <autofix-result>
  // 2. fallback 扫 assistant text
  // 3. 返回完整 tag 内容(含 schema)
  // 实现 ~30 行
  ...
}
```

#### Step 4: 添加 `enqueueAutofixResultNotification`

文件:`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`(新增 private 函数)

```typescript
function enqueueAutofixResultNotification(
  taskId: string,
  autofixContent: string,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  // 仿 enqueueRemoteReviewNotification:
  // 1. markTaskNotified guard 防重
  // 2. 构造 task-notification XML 包裹 autofixContent
  // 3. enqueuePendingNotification
  ...
}
```

#### Step 5: 修改 framework 完成分支调用 autofix 专用 enqueue

文件:`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:838-879`

```typescript
if (result || sessionDone || reviewTimedOut) {
  const finalStatus = result && result.subtype !== 'success' ? 'failed' : 'completed'

  // 新增分支:autofix 内容回流
  if (task.remoteTaskType === 'autofix-pr' && finalStatus === 'completed') {
    const autofixContent = extractAutofixResultFromLog(accumulatedLog)
    if (autofixContent) {
      enqueueAutofixResultNotification(taskId, autofixContent, context.setAppState)
      void evictTaskOutput(taskId)
      void removeRemoteAgentMetadata(taskId)
      // ⚠️ 也要清 monitorState
      void clearActiveMonitor(taskId)
      return // Stop polling
    }
    // fall through 到 generic enqueueRemoteNotification(如果未提取到内容)
  }

  if (task.isRemoteReview) { ... }  // 现有分支不变

  enqueueRemoteNotification(...)   // generic 分支(autofix 提取失败时也会走到这里)
  void clearActiveMonitor(taskId)  // ⚠️ autofix 也要清,即使走 generic 分支
  return
}
```

#### Step 6: 修改远端 agent system prompt

文件:`src/commands/autofix-pr/launchAutofixPr.ts`(prompt 模板部分)

在 `initialMessage` 中加入指令:

```text
When you complete the autofix work,output the following XML tag as your final message:

<autofix-result>
  <pr-number>${prNumber}</pr-number>
  <commits-pushed>
    <commit sha="...">...</commit>
  </commits-pushed>
  <files-changed>
    <file path="...">N changes</file>
  </files-changed>
  <ci-status>green | red | pending</ci-status>
  <summary>One-sentence summary of what was fixed.</summary>
</autofix-result>

If no fix was needed or the fix failed, omit the <commits-pushed> block and explain in <summary>.
```

#### Step 7: 测试

文件:`src/commands/autofix-pr/__tests__/launchAutofixPr.test.ts`

新增测试用例:
- `taskId 不一致 bug 修复`: 验证 `updateActiveMonitor` 在 register 后被调用
- `completionChecker 注册`: 验证 `registerCompletionChecker('autofix-pr', ...)` 在模块加载时调用
- `extractAutofixResultFromLog`: 验证从 hook stdout / assistant text 中提取 tag

文件:`src/tasks/RemoteAgentTask/__tests__/RemoteAgentTask.test.tsx`

新增:
- `autofix-pr 完成走 enqueueAutofixResultNotification 分支`: mock log 含 `<autofix-result>` tag,验证 enqueue 调用 + clearActiveMonitor 调用
- `autofix-pr 完成但 tag 缺失走 generic 分支`: 验证 fallback 行为

---

## 第六部分 · 代码 diff 示意

### 6.1 修 Bug 7(taskId 不一致)

```diff
// src/commands/autofix-pr/monitorState.ts
+ export function updateActiveMonitor(partial: Partial<MonitorState>): void {
+   if (active === null) return
+   active = { ...active, ...partial }
+ }

// src/commands/autofix-pr/launchAutofixPr.ts
- const { taskId } = createAutofixTeammate(...)
- setActiveMonitor({ taskId, owner, repo, prNumber, ... })
+ const { taskId: teammateId } = createAutofixTeammate(...)
+ setActiveMonitor({ taskId: teammateId, owner, repo, prNumber, ... })

  const session = await teleportToRemote(...)
  if (!session) return

- registerRemoteAgentTask({ ... })
+ const { taskId: frameworkTaskId } = registerRemoteAgentTask({ ... })
+ updateActiveMonitor({ taskId: frameworkTaskId })
```

### 6.2 注册 completionChecker

```diff
// src/commands/autofix-pr/launchAutofixPr.ts(模块顶部)
+ import {
+   registerCompletionChecker,
+   type RemoteAgentTaskState,
+ } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js'
+ import { checkPrAutofixOutcome } from './prOutcomeCheck.js'

+ async function autofixCompletionChecker(
+   task: RemoteAgentTaskState,
+ ): Promise<string | null> {
+   const meta = task.remoteTaskMetadata as
+     | { owner: string; repo: string; prNumber: number; initialHeadSha?: string }
+     | undefined
+   if (!meta) return null
+   const result = await checkPrAutofixOutcome(meta.owner, meta.repo, meta.prNumber, {
+     initialHeadSha: meta.initialHeadSha,
+     timeout: 5000,
+   }).catch(() => null)
+   if (!result?.completed) return null
+   return `Autofix completed on ${meta.owner}/${meta.repo}#${meta.prNumber}: ${result.summary}`
+ }

+ // 模块加载时注册(进程级单例)
+ registerCompletionChecker('autofix-pr', autofixCompletionChecker)
```

### 6.3 framework 完成分支添加 autofix 内容回流

```diff
// src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:838-879
  if (result || sessionDone || reviewTimedOut) {
    const finalStatus = result && result.subtype !== 'success' ? 'failed' : 'completed'

+   // autofix-pr: 提取 <autofix-result> tag 并回流
+   if (task.remoteTaskType === 'autofix-pr' && finalStatus === 'completed') {
+     const autofixContent = extractAutofixResultFromLog(accumulatedLog)
+     if (autofixContent) {
+       enqueueAutofixResultNotification(taskId, autofixContent, context.setAppState)
+       void evictTaskOutput(taskId)
+       void removeRemoteAgentMetadata(taskId)
+       void clearActiveMonitor(taskId)
+       return
+     }
+   }

    if (task.isRemoteReview) {
      // ... 现有逻辑不变 ...
    }

    enqueueRemoteNotification(taskId, task.title, finalStatus, context.setAppState, task.toolUseId)
    void evictTaskOutput(taskId)
    void removeRemoteAgentMetadata(taskId)
+   // autofix 即使走 generic 分支也要清 monitor lock
+   if (task.remoteTaskType === 'autofix-pr') {
+     void clearActiveMonitor(taskId)
+   }
    return
  }
```

### 6.4 远端 system prompt 模板

```diff
// src/commands/autofix-pr/launchAutofixPr.ts
  const initialMessage = `Auto-fix failing CI checks on PR #${prNumber} in ${owner}/${repo}.${skillsHint}
+
+ When you complete the autofix work, output the following XML tag as your final message:
+
+ <autofix-result>
+   <pr-number>${prNumber}</pr-number>
+   <commits-pushed>
+     <commit sha="...">commit message</commit>
+   </commits-pushed>
+   <files-changed>
+     <file path="...">N changes</file>
+   </files-changed>
+   <ci-status>green | red | pending</ci-status>
+   <summary>One-sentence summary of what was fixed.</summary>
+ </autofix-result>
+
+ If no fix was needed or the fix failed, omit the <commits-pushed> block and explain in <summary>.`
```

### 6.5 新增 extractAutofixResult.ts

```typescript
// src/commands/autofix-pr/extractAutofixResult.ts
import type { SDKMessage } from 'src/types/sdk.js'

export const AUTOFIX_RESULT_TAG = 'autofix-result'

const TAG_OPEN = `<${AUTOFIX_RESULT_TAG}>`
const TAG_CLOSE = `</${AUTOFIX_RESULT_TAG}>`

export function extractAutofixResultFromLog(log: SDKMessage[]): string | null {
  // 1) 扫 hook_progress / hook_response stdout(高优先级,因为 hook 输出更结构化)
  for (const msg of log) {
    if (msg.type !== 'user' || !Array.isArray(msg.message?.content)) continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.includes(TAG_OPEN)
      ) {
        const extracted = extractBetween(block.content, TAG_OPEN, TAG_CLOSE)
        if (extracted) return extracted
      }
    }
  }

  // 2) Fallback 扫 assistant text(允许 agent 直接在消息里输出 tag)
  for (let i = log.length - 1; i >= 0; i--) {
    const msg = log[i]
    if (msg?.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.includes(TAG_OPEN)) {
        const extracted = extractBetween(block.text, TAG_OPEN, TAG_CLOSE)
        if (extracted) return extracted
      }
    }
  }

  return null
}

function extractBetween(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  if (start === -1) return null
  const end = text.indexOf(close, start + open.length)
  if (end === -1) return null
  return text.slice(start, end + close.length)
}
```

### 6.6 新增 enqueueAutofixResultNotification

```typescript
// src/tasks/RemoteAgentTask/RemoteAgentTask.tsx(新增 private 函数,放在 line 394 附近)

function enqueueAutofixResultNotification(
  taskId: string,
  autofixContent: string,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  if (!markTaskNotified(taskId, setAppState)) return

  const STATUS_TAG = 'status'
  const SUMMARY_TAG = 'summary'

  const message = [
    `<task-notification>`,
    `<task-id>${taskId}</task-id>`,
    `<task-type>autofix-pr</task-type>`,
    `<${STATUS_TAG}>completed</${STATUS_TAG}>`,
    `<${SUMMARY_TAG}>Autofix completed</${SUMMARY_TAG}>`,
    autofixContent,
    `</task-notification>`,
    '',
    'The remote autofix-pr agent has completed. Summarize the changes for the user based on the autofix-result content above.',
  ].join('\n')

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
  })
}
```

---

## 第七部分 · 实施 checklist 与回归测试

### 7.1 实施 checklist

**Phase 1: 修 latent bug(必做)**

- [ ] 在 `monitorState.ts` 添加 `updateActiveMonitor()` 导出
- [ ] 修改 `callAutofixPr` 在 register 后调 `updateActiveMonitor({ taskId: frameworkTaskId })`
- [ ] 在 framework 完成分支(`RemoteAgentTask.tsx:876` 附近)对 autofix-pr 调 `clearActiveMonitor(taskId)`
- [ ] 添加回归测试:验证完整流程 launch → CCR archived → monitor cleared

**Phase 2: 注册 completionChecker(强烈推荐)**

- [ ] 新增 `src/commands/autofix-pr/prOutcomeCheck.ts`,实现 `checkPrAutofixOutcome`
- [ ] 在 `launchAutofixPr.ts` 模块顶部调用 `registerCompletionChecker('autofix-pr', ...)`
- [ ] 在 `callAutofixPr` 中把 `initialHeadSha` 加入 `remoteTaskMetadata`
- [ ] 单元测试 `prOutcomeCheck.ts`(mock gh CLI 输出)

**Phase 3: 内容回流(推荐方案 C)**

- [ ] 新增 `src/commands/autofix-pr/extractAutofixResult.ts`
- [ ] 在 `RemoteAgentTask.tsx` 添加 `enqueueAutofixResultNotification` 私有函数
- [ ] 在 framework 完成分支添加 autofix-pr 内容回流分支
- [ ] 修改 `launchAutofixPr.ts` 的 `initialMessage` 加入 `<autofix-result>` 输出指令
- [ ] 测试:
  - mock log 含 `<autofix-result>` tag → 验证 `enqueueAutofixResultNotification` 调用
  - mock log 不含 tag → 验证 fallback 到 `enqueueRemoteNotification`

**Phase 4: 可选 — 完成 dialog(方案 B 扩展)**

- [ ] 新增 AppState 字段 `autofixPendingChoice?: { autofixContent, sessionId, taskId }`
- [ ] 新增 `src/components/autofix-pr/AutofixCompletionDialog.tsx`
- [ ] 在 framework 完成分支(autofix-pr 内容回流分支)改为 set `autofixPendingChoice` 而非直接 enqueue
- [ ] REPL 检测 `autofixPendingChoice` 挂载 dialog
- [ ] Dialog 选择"Stop monitoring"时调 `archiveRemoteSession(sessionId)`
- [ ] 视觉回归测试 + 用户流程 e2e

### 7.2 回归测试要点

1. **Lock 释放回归**:
   - 跑 `/autofix-pr 12` → 等 CCR 自然 archive
   - 再跑 `/autofix-pr 14` → 应该成功,不出现 "already monitoring"

2. **`/autofix-pr stop` 行为不变**:
   - Stop 仍然只停本地 + archive(走 kill 路径)
   - 不应被 Phase 1 改动破坏

3. **completionChecker 不引入额外延迟**:
   - 测量 5 次 idle poll 加 checker 调用的总延迟 ≤ 1500ms
   - checker timeout 不应导致 task stuck

4. **`<autofix-result>` 提取健壮性**:
   - 缺失整个 tag → fallback generic notification
   - tag 在 hook stdout vs assistant text 都能提取
   - tag 内部 XML 不严格(允许嵌套 < > 字符)

5. **CCR session 状态对齐**:
   - 自然完成时 session 保持 alive(可在 claude.ai/code 查看)
   - kill 时 session archived

### 7.3 性能 / 资源影响评估

| 指标 | 影响 |
|---|---|
| 轮询频率 | 不变(1000ms) |
| 单 tick 工作量 | 仅在 stableIdle 时调用 completionChecker(5s 后才开始触发),后续每 1s 调一次 gh CLI |
| 内存 | 新增 `cachedAutofixContent` 字段(类似 `cachedReviewContent`),~几 KB |
| Network | 多了 gh CLI 调用(每 5-10s 一次,5KB level),可忽略 |
| 用户感知延迟 | autofix 完成 → 消息流出现 task-notification 之间额外 +1-3s |

---

## 附录 A · 关键 API / 函数速查表

| 函数 | 位置 | 用途 |
|---|---|---|
| `teleportToRemote(options)` | `src/utils/teleport.tsx:818` | 创建远端 CCR session |
| `archiveRemoteSession(sessionId, timeout?)` | `src/utils/teleport.tsx:1328` | POST /v1/sessions/{id}/archive,fire-and-forget |
| `pollRemoteSessionEvents(sessionId, afterId?, opts?)` | `src/utils/teleport.tsx:723` | 分页拉取增量事件 |
| `registerRemoteAgentTask(options)` | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:468` | 注册 task + 启动轮询,返回 `{taskId, sessionId, cleanup}` |
| `registerCompletionChecker(remoteTaskType, checker)` | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:113` | 注册类型专属 completion checker |
| `updateTaskState<T>(taskId, setAppState, updater)` | `src/utils/task/framework.ts:48` | 原子更新 task 状态 |
| `enqueuePendingNotification(command)` | `src/utils/messageQueueManager.ts:142` | 把命令排入消息队列 |
| `enqueueRemoteReviewNotification(taskId, content, setAppState)` | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:394` | private,内联 review 文本注入 |
| `enqueueRemoteNotification(taskId, title, status, setAppState, toolUseId?)` | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:190` | private,generic 完成通知(file path) |
| `pollForApprovedExitPlanMode(sessionId, timeoutMs, onPhaseChange?, shouldStop?)` | `src/utils/ultraplan/ccrSession.ts:198` | ultraplan 专用 detached poll |
| `RemoteAgentTask.kill(taskId, setAppState)` | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:936` | Kill task + archive |
| `extractPlanFromLog(log)` | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:236` | 提取 `<ultraplan>` tag |
| `extractReviewFromLog(log)` | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:291` | 提取 `<remote-review>` tag(含 untagged fallback) |
| `extractReviewTagFromLog(log)` | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:353` | 仅 tag 模式,无 fallback |
| `clearActiveMonitor(taskId?)` | `src/commands/autofix-pr/monitorState.ts:42` | 清 autofix singleton lock |

---

## 附录 B · 我之前两次回答的判断错误

### 错误 1:"ultraplan 走 RemoteAgentTask 的 finalStatus 分支"

**纠正**:`RemoteAgentTask.tsx:705-706` 的 `isUltraplan` 守卫让 ultraplan 标准 poller 永远不取到 `result`,因此 line 838 的 terminal 分支不会从标准 poller 触发。ultraplan 的完成完全由 `startDetachedPoll` → `pollForApprovedExitPlanMode` 接管,标准 poller 只负责填充 `task.log` 给 detail view。

### 错误 2:"整个框架都不主动 archive 云端"

**部分纠正**:
- ✅ 标准轮询循环在自然完成时确实不 archive(line 837-880 的 terminal 分支只 evict,不 archive)
- ❌ 但 `RemoteAgentTask.kill()` 对所有 task 类型都 archive(line 964-968)
- ❌ ultraplan 在 3 处显式 archive:
  - `ultraplan.tsx:171`(错误路径)
  - `UltraplanChoiceDialog.tsx:177`(用户选择后)
  - `ultraplan.tsx:423`(`registerCleanup` 进程退出 safety net)

**统一表述**:"标准轮询循环在自然完成时不主动 archive;主动 archive 由各命令的业务逻辑(kill / dialog 选择 / 错误路径 / 进程退出)显式触发"。

### 错误 3:"ultraplan 的回流是轻量通知"

**纠正**:ultraplan 的回流不仅不是轻量通知,而且是三个命令中**最重的**——它包含:
- 自定义 detached poll(`startDetachedPoll`)
- 自定义事件检测(`ExitPlanModeScanner`)
- 完整内容提取(`extractApprovedPlan` / `extractTeleportPlan`)
- 用户交互 dialog(`UltraplanChoiceDialog`,3 选项)
- 主动 archive(在 dialog 选择后)
- AppState 字段(`ultraplanPendingChoice`, `ultraplanSessionUrl`, `ultraplanLaunching`)

ultrareview 的回流次重(内容回流但无 dialog),autofix-pr 的回流最轻(只 generic 通知)。

---

## 附录 C · CCR Beta header 与 SDK 版本对齐

当前实现使用的 CCR API beta header:

```http
anthropic-beta: ccr-byoc-2025-07-29
```

如果未来 Anthropic 发布新版 BYOC API(如 `ccr-byoc-2026-MM-DD`),需要同步更新:
- `src/utils/teleport.tsx`(`pollRemoteSessionEvents` 等函数中的 header)
- `archiveRemoteSession` 的 header
- 其他直接调用 CCR REST API 的位置

SDK v1 `query()` 和 v2 `unstable_v2_createSession` 不直接使用 BYOC header,但底层走的同一 CCR 集群。版本兼容性以 BYOC header 为准。

---

**文档版本**:1.0
**最后更新**:2026-05-18
**作者**:基于本次会话的调研综合(docs-lookup agent + code-explorer agent)
**相关 PR**:(待定 — 实施方案 C 时的 PR 编号)
