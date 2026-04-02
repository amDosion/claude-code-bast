# Claude Code CLI 开发计划

## 目标

把当前还原仓库从“可研究”推进到“可持续开发”的状态，并建立一条可重复执行的开发路径。

本计划服务于两件事：

1. 让后续开发不再依赖零散口头分析。
2. 让每个开发阶段都有明确的交付物、验证方式和完成标准。

配套架构基线见：

- `docs/08-cli-architecture.md`

---

## 当前判断

当前仓库已经具备完整的源码骨架，但后续开发必须围绕下面四个中心推进：

1. 启动与会话链路稳定化
2. 查询与工具执行链可验证化
3. 任务、子代理与恢复链可维护化
4. 扩展系统装配边界清晰化

如果没有这四步，直接在功能层继续堆开发，后面会在 `main.tsx`、`REPL.tsx`、`query.ts`、`sessionStorage.ts` 这些高耦合点反复返工。

---

## 分阶段计划

## Phase 0 - 环境与验证基线

### 目标

建立最基本的可运行、可观察、可复现开发环境。

### 工作项

1. 恢复 Bun / Node 运行环境，确保仓库能执行最小 smoke。
2. 固化基础命令：
   - `bun install`
   - `bun run version`
   - `bun run dev`
3. 建立最小开发记录：
   - 当前可运行入口
   - 当前不能运行的链路
   - 本地环境约束

### 交付物

- 可执行的本地开发环境
- 一组最小 smoke 命令
- 失败链路清单

### 完成标准

- `bun run version` 正常输出版本
- `bun run dev` 能启动主 CLI
- 至少完成一次新会话启动与退出验证

---

## Phase 1 - 启动与会话骨架

### 目标

吃透并稳定启动分流、初始化、会话建立、模式选择。

### 关注文件

- `src/dev-entry.ts`
- `src/entrypoints/cli.tsx`
- `src/main.tsx`
- `src/entrypoints/init.ts`
- `src/setup.ts`

### 工作项

1. 画清 fast-path 与完整启动链的分界。
2. 标记哪些初始化属于全局环境，哪些属于会话环境。
3. 验证 REPL、headless、remote/teleport 的入口分支。
4. 给启动链补最小 smoke 说明或脚本化验证入口。

### 交付物

- 启动链说明
- 模式分流表
- 会话初始化边界清单

### 完成标准

- 能明确回答每个 CLI 入口由哪个文件接管
- 能明确回答 `init.ts` 和 `setup.ts` 的职责分界
- 新增 CLI 行为时能知道应该改哪一层

---

## Phase 2 - 输入、查询、工具执行主链

### 目标

把“用户输入 -> 模型回合 -> tool execution -> 结果回流”的链条彻底打通。

### 关注文件

- `src/utils/handlePromptSubmit.ts`
- `src/utils/processUserInput/processUserInput.ts`
- `src/query.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/StreamingToolExecutor.ts`
- `src/utils/permissions/permissions.ts`

### 工作项

1. 固化输入预处理边界。
2. 固化 query 与 tool execution 的职责边界。
3. 识别串并行调度与顺序回填的约束。
4. 补权限链的行为图。
5. 找出最适合落测试/验证的节点。

### 交付物

- 输入到工具执行的完整调用链
- 权限决策说明
- tool 执行风险点清单

### 完成标准

- 新增 slash command、input hook、tool policy 时能准确落点
- 新增 tool 时知道需要经过哪些层
- 能说明 query 层与 tool 层分别负责什么

---

## Phase 3 - 任务、子代理、后台执行、恢复

### 目标

把这个 CLI 最难维护的运行时语义稳定下来：后台任务、子代理、远程任务、resume。

### 关注文件

- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`
- `src/tasks/LocalMainSessionTask.ts`
- `src/utils/task/framework.ts`
- `src/utils/sessionStorage.ts`
- `src/utils/sessionRestore.ts`
- `src/screens/REPL.tsx`

### 工作项

1. 明确 task state 的生命周期。
2. 明确本地 agent、主会话后台化、远程 agent 的差异。
3. 明确 transcript、sidecar metadata、task output 的关系。
4. 验证 resume/continue 对工作区、agent、任务恢复的影响。

### 交付物

- 任务生命周期说明
- 恢复语义说明
- transcript 与 sidecar 约定说明

### 完成标准

- 可以稳定解释任务为什么能被恢复
- 可以稳定解释哪些状态属于 transcript，哪些不属于
- 修改 task/resume 行为时不再只看单文件

---

## Phase 4 - 扩展系统收敛

### 目标

把 commands、skills、plugins、MCP 的装配关系文档化并形成稳定开发边界。

### 关注文件

- `src/commands.ts`
- `src/skills/loadSkillsDir.ts`
- `src/skills/mcpSkills.ts`
- `src/utils/plugins/pluginLoader.ts`
- `src/utils/plugins/mcpPluginIntegration.ts`
- `src/services/mcp/config.ts`
- `src/services/mcp/client.ts`
- `src/services/mcp/useManageMCPConnections.ts`

### 工作项

1. 区分命令扩展、工具扩展、MCP 扩展、plugin 组件扩展。
2. 验证 plugin -> MCP server -> tool/command/resource 的装配链。
3. 识别热加载、重连、去重、启停的约束。
4. 标记当前恢复树中未完全落地的扩展点。

### 交付物

- 扩展系统矩阵
- MCP 装配与重连说明
- 插件装配边界说明

### 完成标准

- 新能力接入时能明确选对扩展入口
- 不再把 skill、plugin、MCP 视作同一层东西
- 能判断某个扩展 bug 应该落在哪个模块修

---

## Phase 5 - 开发者体验与最小验证体系

### 目标

给后续功能开发补最小但稳定的验证抓手。

### 工作项

1. 为关键链路补 smoke 清单。
2. 为高风险子系统补接近模块的验证入口。
3. 给文档补“改某类功能先看哪些文件”的开发指南。
4. 在不引入大规模测试基础设施的前提下，先建立 targeted verification。

### 交付物

- 最小 smoke 手册
- 关键链路验证手册
- 开发切入指南

### 完成标准

- 每次改动都能找到对应的验证动作
- 关键链路至少具备手工 smoke 方案
- 文档足以支撑后续多人继续开发

---

## 近期优先级

建议严格按下面顺序推进，不要跳阶段：

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5

原因很简单：

- 不先恢复运行环境，后面所有理解都停留在静态层。
- 不先稳定启动和查询主链，后面做任务和扩展只会放大耦合。
- 不先梳理恢复语义，后面做 agent 和 remote 功能最容易返工。

---

## 当前已完成的基础工作

目前已经完成：

1. 识别项目本体是 agent runtime，而不是普通 CLI。
2. 梳理了启动分流、输入主链、query/tool 主链。
3. 梳理了 task/subagent/remote task 的生命周期骨架。
4. 梳理了 transcript、resume、plugin、MCP 的核心入口。
5. 生成了架构基线文档 `docs/08-cli-architecture.md`。

---

## 当前风险

| 风险 | 说明 |
|------|------|
| 运行环境未恢复 | 没有稳定 Bun/Node 运行环境，很多判断仍停留在静态阅读层 |
| 大文件高耦合 | `main.tsx`、`REPL.tsx`、`query.ts`、`sessionStorage.ts` 都是高风险改动点 |
| feature gate 复杂 | 编译期 gate 与运行期条件叠加，容易只验证到一部分路径 |
| 恢复语义脆弱 | 改动 transcript / task / resume 任一层都可能引发跨层回归 |

---

## 下一轮触发条件

当下面任一条件满足时，进入下一轮开发工作：

1. 本地运行环境恢复完成，可以跑 `bun run version` 和 `bun run dev`
2. 需要正式开始某一条功能线开发
3. 需要把某个高风险子系统拆成更细的实现计划

下一轮优先动作建议：

1. 恢复运行环境
2. 跑通启动 smoke
3. 以 `main.tsx -> setup.ts -> REPL.tsx -> query.ts` 为主线做第一次动态验证
