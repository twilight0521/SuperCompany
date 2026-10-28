# AI 指挥台产品架构文档

## 1. 总体架构

建议采用“本地优先、云端可选”的架构。

```
flowchart LR
    U[用户] --> C[桌面端/网页端]
    C --> O[Orchestrator 编排器]
    O --> P[GPT 规划与 Review]
    O --> G[任务图引擎]
    O --> A[Agent Adapter Gateway]
    A --> S[Shell Agent]
    A --> H[HTTP/API Agent]
    A --> B[Browser Agent]
    A --> M[Office Agent]
    O --> R[本地 Runner]
    R --> W[Git Worktree]
    R --> F[文件系统]
    O --> E[事件总线]
    E --> L[日志与时间线]
    O --> V[审批与权限策略]
    O --> D[SQLite/数据库]
```

## 2. 部署模式

### 模式 A：本地个人版

适合 MVP。

```
桌面端
├── UI
├── 编排器
├── 本地 Runner
├── Agent 适配器
├── SQLite
├── Git 管理器
└── 系统密钥链
```

优点：

- 不需要维护服务器
- 代码不离开本地
- 成本低
- 能直接使用本地 CLI Agent
- 适合个人开发者

推荐技术：

- Tauri 或 Electron
- TypeScript
- Node.js
- SQLite
- Drizzle ORM
- Git CLI
- WebSocket
- JSON Schema

### 模式 B：云端控制台 + 本地执行器

适合后续版本。

```
云端控制台
├── 用户与项目
├── 任务编排
├── GPT 服务
├── 事件服务
└── 成本统计

本地执行器
├── 代码访问
├── Git Worktree
├── CLI Agent
├── 测试
└── 敏感数据访问
```

云端只负责：

- 任务状态
- 项目计划
- 消息和事件
- 远程查看

本地执行器负责：

- 访问代码
- 执行命令
- 修改文件
- 运行测试
- 调用本地 Agent

## 3. 核心模块

### 3.1 Project Service

负责：

- 项目创建
- 项目配置
- 代码目录绑定
- Agent 配置
- 项目预算
- 项目上下文

### 3.2 Context Manager

负责构建 GPT 上下文：

- 需求文档
- 架构文档
- 相关代码
- Git Diff
- 历史 Review
- 测试结果
- 用户决策

上下文应使用引用方式：

```
{
  "type": "file",
  "path": "src/player/player.gd",
  "lineStart": 1,
  "lineEnd": 180
}
```

避免每次把整个项目发送给模型。

### 3.3 Task Graph Engine

任务不是简单列表，而是有依赖关系的有向无环图。

```
项目目标
  ├── 产品设计
  ├── 技术架构
  ├── 基础工程
  │     ├── 玩家系统
  │     ├── 敌人系统
  │     └── UI 系统
  ├── 测试
  └── GPT Review
```

任务只有在依赖任务完成后才能执行。

### 3.4 Agent Adapter Gateway

统一不同 Agent 的调用方式。

每个适配器负责：

- 参数转换
- 上下文注入
- 任务启动
- 流式日志
- 结果解析
- 错误标准化
- 能力声明
- 成本统计

### 3.5 Local Runner

负责本地执行：

- 创建 Worktree
- 执行命令
- 监控进程
- 限制文件访问
- 收集日志
- 获取 Git Diff
- 运行测试
- 回滚失败任务

### 3.6 Policy Engine

根据任务风险决定是否需要审批。

示例：

```
{
  "action": "git.push",
  "risk": "high",
  "requiresApproval": true
}
```

规则示例：

- 读取项目文件：允许
- 修改源代码：允许
- 删除文件：需要确认
- 修改数据库：需要确认
- 执行 `rm -rf`：禁止
- 推送远程仓库：需要确认
- 发布部署：需要确认

### 3.7 Review Service

Review Service 将以下内容提交给 GPT：

- 原始需求
- 任务验收标准
- 修改前代码
- 修改后 Diff
- 测试输出
- Agent 自评结果

输出统一格式：

```
{
  "status": "needs_changes",
  "score": 72,
  "findings": [
    {
      "severity": "high",
      "file": "src/player.gd",
      "description": "角色死亡后仍然可以接收输入"
    }
  ],
  "repairTasks": [
    "修复角色死亡状态下的输入处理",
    "增加角色死亡测试"
  ]
}
```

## 4. Agent 协议

### 任务请求

```
{
  "taskId": "task_123",
  "projectId": "project_001",
  "title": "实现玩家移动",
  "goal": "使用 Godot 实现 WASD 玩家移动",
  "contextRefs": [
    "docs/architecture.md",
    "src/player/player.gd"
  ],
  "allowedPaths": [
    "src/player/**",
    "tests/player/**"
  ],
  "allowedCommands": [
    "godot --headless --path . --editor --quit",
    "pytest"
  ],
  "acceptanceCriteria": [
    "支持 WASD 移动",
    "移动速度可配置",
    "存在基础测试"
  ],
  "budget": {
    "maxTokens": 12000,
    "maxCost": 0.1
  }
}
```

### 任务事件

```
{
  "eventId": "event_001",
  "taskId": "task_123",
  "type": "artifact_created",
  "timestamp": "2026-10-28T12:00:00Z",
  "payload": {
    "path": "src/player/player.gd",
    "kind": "file"
  }
}
```

事件类型：

- `task_started`
- `progress_updated`
- `command_started`
- `command_finished`
- `file_changed`
- `artifact_created`
- `test_passed`
- `test_failed`
- `approval_required`
- `task_completed`
- `task_failed`
- `review_completed`

## 5. 数据模型

### Project

```
id
name
description
root_path
repository_url
tech_stack
budget_limit
created_at
updated_at
```

### Task

```
id
project_id
parent_id
title
goal
status
priority
assigned_agent
dependencies
acceptance_criteria
allowed_paths
allowed_commands
created_at
completed_at
```

### Run

```
id
task_id
agent_id
worktree_path
started_at
finished_at
exit_code
cost
status
```

### Artifact

```
id
project_id
task_id
type
path
hash
version
created_at
```

### Review

```
id
task_id
reviewer
status
score
findings
repair_tasks
created_at
```

### Approval

```
id
project_id
action
risk_level
description
status
approved_by
created_at
```

## 6. 任务执行流程

```
sequenceDiagram
    participant User as 用户
    participant GPT as GPT
    participant O as 编排器
    participant A as Agent
    participant R as Runner
    participant Rev as Review

    User->>GPT: 提交项目目标
    GPT->>O: 创建项目计划和任务图
    O->>User: 请求确认计划
    User->>O: 批准执行
    O->>A: 派发任务
    A->>R: 修改文件并运行测试
    R-->>O: 返回日志、Diff、测试结果
    O->>Rev: 提交 Review
    Rev->>GPT: 分析任务结果
    GPT-->>O: 通过或生成修复任务
    O->>User: 请求高风险操作审批
    User-->>O: 批准或拒绝
    O-->>User: 输出最终项目报告
```

## 7. GPT 与 ChatGPT Plus 的产品约束

产品需要支持三种 GPT 接入模式：

### API 模式

用户提供 API Key。

优点：

- 可自动调用
- 适合批量任务
- 适合后台运行

限制：

- ChatGPT Plus 与 API 账单通常是独立的
- 需要用户单独配置 API 额度

### ChatGPT 辅助模式

用户在 ChatGPT 中进行规划和 Review，指挥台负责：

- 准备上下文
- 生成任务包
- 收集执行结果
- 生成 Review 输入
- 保存最终结论

优点：

- 更符合“默认已有 GPT Plus”的用户假设
- 不需要把产品核心绑定到网页自动化

限制：

- 自动化程度较低
- 某些步骤需要用户确认或复制

### 混合模式

- 低成本任务交给 DeepSeek、其他 API 或本地模型
- 高价值规划和最终 Review 使用 GPT
- 关键步骤由用户确认

这是最适合目标用户的默认模式。

不要把核心能力建立在模拟点击 ChatGPT 网页或抓取网页 DOM 上。没有稳定官方接口的产品，应通过适配器、文件协议或人工接管方式接入。

## 8. 成本路由策略

默认策略：

```
简单任务 → 本地模型或低价模型
普通编码 → DeepSeek / 低价 API
复杂架构 → GPT
最终 Review → GPT
高风险决策 → GPT + 人工
```

路由依据：

- 任务类型
- 文件数量
- 代码复杂度
- 失败代价
- 当前预算
- 历史成功率
- Agent 响应速度

## 9. 安全设计

### 文件安全

- 每个任务使用独立 Worktree
- 限制可读路径
- 限制可写路径
- 保存操作前快照
- 任务失败可回滚

### 命令安全

- 命令白名单
- 危险命令拦截
- 超时终止
- 资源限制
- 进程树清理

### 凭证安全

- 使用系统密钥链
- Token 不写入日志
- Token 不直接放入 Prompt
- 不把项目密钥同步到云端
- 支持按 Agent 单独授权

### 审计

记录：

- 谁发起任务
- 哪个 Agent 执行
- 修改了哪些文件
- 执行了什么命令
- GPT 给出了什么判断
- 用户批准了什么操作

## 10. 故障处理

### Agent 无响应

- 自动超时
- 重试一次
- 切换备用 Agent
- 请求人工接管

### 代码冲突

- 停止后续任务
- 展示冲突文件
- 创建冲突解决任务
- 让 GPT 生成解决建议
- 用户确认后合并

### Review 不通过

- 生成修复任务
- 保留原始 Diff
- 限制最大修复轮数
- 超过轮数后请求人工判断

### 预算不足

- 停止新增任务
- 完成正在运行任务
- 使用低成本模型重试
- 请求用户追加预算

## 11. 推荐技术栈

### MVP

- 桌面端：Tauri
- 前端：React + TypeScript
- 本地服务：Node.js
- 数据库：SQLite
- ORM：Drizzle
- 通信：WebSocket
- 校验：Zod / JSON Schema
- Git：Git CLI
- 日志：结构化 JSON
- 密钥：系统 Keychain

### 后续云端

- API：TypeScript / Fastify
- 数据库：PostgreSQL
- 队列：Redis 或消息队列
- 对象存储：S3 兼容存储
- 身份认证：OAuth
- 远程执行：容器化 Runner

## 12. 推荐开发顺序

### 第 1 周

- 项目空间
- SQLite 数据模型
- 基础页面
- GPT 对话和计划生成

### 第 2 周

- 任务图
- Shell Agent
- 本地 Runner
- Git Worktree

### 第 3 周

- 执行日志
- 文件 Diff
- 测试结果收集
- 失败重试

### 第 4 周

- GPT Review
- 审批机制
- 成本统计
- 项目报告

### 第 5 周

- HTTP Agent
- DeepSeek 或通用 OpenAI 兼容接口
- Agent 能力配置

### 第 6 周

- 游戏项目实测
- 错误处理
- 安全策略
- MVP 发布

## 13. 第一版最重要的产品判断

第一版不要尝试同时接入所有工具。

建议先实现：

```
GPT
  ↓
统一任务图
  ↓
本地 Shell / OpenCode 类 Agent
  ↓
Git Worktree
  ↓
测试
  ↓
GPT Review
```

只要这条链路能稳定完成一个小型游戏功能，产品就已经验证了核心价值。

之后再接入 DeepSeek、Cursor、WorkBuddy、豆包、Grok 和办公工具。