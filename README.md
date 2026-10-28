# AI 指挥台

本地优先的多 Agent 协作工作台：GPT 负责理解目标、拆任务、Review 与验收；Shell / HTTP 等执行 Agent 负责改代码、跑命令、拉接口；人类负责关键审批。

依据仓库内《AI 指挥台 PRD》与《AI 指挥台产品架构文档》实现 MVP。

## 能力（V0.1）

- 项目空间（目标、技术栈、本地目录、预算、GPT 模式）
- GPT 规划（OpenAI 兼容 API / Codex CLI / ChatGPT 粘贴导入 / 本地回退计划）
- 任务依赖图与状态机
- 本地 Shell Agent（Git Worktree 隔离、命令策略、Diff、测试收集）
- 通用 HTTP Agent
- GPT Review 与修复任务
- 人工审批（高风险命令 / 预算）
- SQLite 持久化 + WebSocket 时间线
- 基础成本统计与版本报告

## 运行

需要 Node.js 20+（推荐 22/24，内置 `node:sqlite`）。

```bash
npm install
npm run dev
```

- UI：http://127.0.0.1:5173
- API：http://127.0.0.1:4317

仅启动后端：

```bash
npm start
```

生产静态资源：

```bash
npm run build
npm start
```

## 推荐演示路径

1. 准备一个空目录作为「本地代码目录」。
2. 创建项目，填写目标与绝对路径。
3. 点击「GPT 规划」（无 API Key 时使用本地回退计划，仍不少于 5 个任务）。
4. 「批准执行」生成任务图。
5. 多次「执行下一任务」：Shell/HTTP 改文件、跑测试，随后自动 Review。
6. 在底部查看日志 / Diff / 测试 / Review；右侧处理审批。
7. 「版本报告」导出 `docs/ai-command-center/release-report.md`。

可选：在右上角设置中配置 OpenAI Compatible API Key（也支持 DeepSeek 等兼容端点）。ChatGPT Plus 用户可复制规划提示词到 ChatGPT，再把 JSON 计划导入。

## 测试

```bash
npm test
```

## 目录

```
src/server/     编排器、任务图、Runner、策略、Review、Agent 适配器、API
src/client/     React 指挥台界面
data/           SQLite 与 worktree（本地生成，不入库）
test/           MVP 闭环测试
```

## 安全默认

- 仅监听 `127.0.0.1`
- `rm -rf` 等危险命令直接拦截
- `git push` / 发布类命令默认需审批
- 代码任务默认进入独立 Git Worktree
- API Key 存在本地 SQLite settings，不写日志

## 非目标（本版不做）

多人协作、云端远程执行、自动发布生产、完整浏览器自动化、Agent 市场、移动端。
