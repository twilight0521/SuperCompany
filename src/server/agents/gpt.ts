import { spawn } from 'node:child_process';
import { getSetting } from '../db/client.ts';
import type { PlanOutput, Project, ReviewOutput, Run, Task } from '../types.ts';
import { recordCost } from '../services/cost.ts';

function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced
    ? fenced[1]
    : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(source) as T;
}

export function buildPlanPrompt(project: Project): string {
  return `你是 AI 指挥台的 GPT 总指挥。请为以下项目输出完整执行计划，只输出 JSON：
{
  "summary": "项目摘要",
  "userStories": ["..."],
  "architecture": "技术架构说明",
  "risks": ["..."],
  "acceptanceCriteria": ["..."],
  "recommendedAgents": ["shell", "http", "gpt"],
  "tasks": [
    {
      "title": "任务标题",
      "goal": "具体目标",
      "priority": 1,
      "assignedAgent": "shell",
      "dependencies": [],
      "acceptanceCriteria": ["可验证标准"],
      "allowedPaths": ["**/*"],
      "allowedCommands": ["npm test", "node --test"]
    }
  ]
}

要求：
1. 至少 5 个任务
2. 任务按依赖顺序排列，dependencies 使用任务 title
3. 包含初始化/实现/测试/文档/Review 相关任务
4. assignedAgent 只能是 shell / http / gpt

项目名称：${project.name}
项目目标：${project.goal}
项目类型：${project.project_type}
技术栈：${project.tech_stack}
本地目录：${project.root_path}
补充说明：${project.description}`;
}

export function buildReviewPrompt(input: {
  project: Project;
  task: Task;
  run: Run;
}): string {
  return `你是代码审查员。根据需求、Diff 和测试结果给出 Review，只输出 JSON：
{
  "status": "passed | conditional | needs_changes",
  "score": 0-100,
  "findings": [{"severity":"low|medium|high","file":"可选","description":"..."}],
  "repairTasks": ["修复任务标题"],
  "summary": "摘要",
  "riskLevel": "low|medium|high|critical"
}

项目目标：${input.project.goal}
任务：${input.task.title}
任务目标：${input.task.goal}
验收标准：${input.task.acceptance_criteria}
执行日志：
${input.run.log.slice(0, 8000)}
Diff：
${input.run.diff.slice(0, 8000)}
测试输出：
${input.run.test_output.slice(0, 4000)}`;
}

export function localFallbackPlan(project: Project): PlanOutput {
  const stack = project.tech_stack || 'Node.js';
  return {
    summary: `${project.name}：围绕「${project.goal || '未填写目标'}」的可执行 MVP 计划`,
    userStories: [
      `作为开发者，我希望完成 ${project.name} 的基础工程搭建`,
      '作为开发者，我希望核心功能可运行并可测试',
      '作为开发者，我希望有文档与验收报告'
    ],
    architecture: `技术栈：${stack}\n本地目录：${project.root_path || '(未绑定)'}\n采用本地 Shell Agent 执行代码变更，GPT 负责规划与 Review，HTTP Agent 处理外部 API。`,
    risks: ['未配置 API Key 时使用本地启发式计划', 'Shell Agent 仅做安全范围内的脚手架与文档写入', '高风险命令需人工审批'],
    acceptanceCriteria: [
      '至少生成 5 个可追踪任务',
      '至少一个任务修改本地文件',
      '自动收集 Diff 与测试结果',
      '产出 Review 报告'
    ],
    recommendedAgents: ['shell', 'gpt', 'http'],
    tasks: [
      {
        title: '初始化工程结构',
        goal: `在本地目录初始化 ${stack} 工程、基础目录与架构文档`,
        priority: 1,
        assignedAgent: 'shell',
        dependencies: [],
        acceptanceCriteria: ['存在基础目录', '存在架构文档'],
        allowedPaths: ['**/*'],
        allowedCommands: ['node --test', 'npm test']
      },
      {
        title: '实现核心功能骨架',
        goal: `根据目标「${project.goal}」创建核心功能代码骨架`,
        priority: 2,
        assignedAgent: 'shell',
        dependencies: ['初始化工程结构'],
        acceptanceCriteria: ['新增功能相关源码文件'],
        allowedPaths: ['src/**', 'docs/**'],
        allowedCommands: ['node --test']
      },
      {
        title: '补充产品与技术文档',
        goal: '整理 README/架构说明与任务笔记',
        priority: 3,
        assignedAgent: 'shell',
        dependencies: ['初始化工程结构'],
        acceptanceCriteria: ['文档可在 docs 目录查看'],
        allowedPaths: ['docs/**', 'README*'],
        allowedCommands: []
      },
      {
        title: '编写并运行基础测试',
        goal: '添加 smoke test 并执行测试命令',
        priority: 4,
        assignedAgent: 'shell',
        dependencies: ['实现核心功能骨架'],
        acceptanceCriteria: ['存在测试文件', '测试命令可执行'],
        allowedPaths: ['test/**', 'src/**'],
        allowedCommands: ['node --test', 'npm test']
      },
      {
        title: '外部依赖探活（可选）',
        goal: '通过 HTTP Agent 检查必要的外部服务可达性（例如 https://httpbin.org/get）',
        priority: 5,
        assignedAgent: 'http',
        dependencies: ['初始化工程结构'],
        acceptanceCriteria: ['记录 HTTP 响应状态'],
        allowedPaths: ['docs/**'],
        allowedCommands: []
      },
      {
        title: 'GPT 最终 Review',
        goal: '汇总 Diff、测试与文档，输出验收结论',
        priority: 6,
        assignedAgent: 'gpt',
        dependencies: ['编写并运行基础测试', '补充产品与技术文档'],
        acceptanceCriteria: ['产出 Review 报告'],
        allowedPaths: ['**/*'],
        allowedCommands: []
      }
    ]
  };
}

export function localFallbackReview(task: Task, run: Run): ReviewOutput {
  const hasDiff = Boolean(run.diff && run.diff.trim());
  const testsOk = !run.test_output || /exit=0/.test(run.test_output);
  const failed = run.status === 'failed' || run.exit_code !== 0;
  if (failed) {
    return {
      status: 'needs_changes',
      score: 45,
      findings: [{ severity: 'high', description: '执行失败，需要修复后重试' }],
      repairTasks: [`修复失败任务：${task.title}`],
      summary: '执行未通过，已生成修复任务建议。',
      riskLevel: 'medium'
    };
  }
  if (!hasDiff && !/gpt/i.test(task.assigned_agent || '')) {
    return {
      status: 'conditional',
      score: 68,
      findings: [{ severity: 'medium', description: '未检测到明显代码 Diff，请确认是否完成实质改动' }],
      repairTasks: [],
      summary: '有条件通过：执行完成但 Diff 有限。',
      riskLevel: 'low'
    };
  }
  return {
    status: testsOk ? 'passed' : 'conditional',
    score: testsOk ? 86 : 72,
    findings: testsOk
      ? [{ severity: 'low', description: '未发现阻断性问题' }]
      : [{ severity: 'medium', description: '测试输出存在失败迹象' }],
    repairTasks: testsOk ? [] : [`修复测试：${task.title}`],
    summary: testsOk ? '通过验收，可继续后续任务。' : '有条件通过，建议关注测试结果。',
    riskLevel: 'low'
  };
}

async function callOpenAICompatible(prompt: string, system: string): Promise<{ text: string; tokens: number; cost: number; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY || getSetting('openai_api_key');
  const baseUrl = (process.env.OPENAI_BASE_URL || getSetting('openai_base_url', 'https://api.openai.com/v1')).replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || getSetting('openai_model', 'gpt-4o-mini');
  if (!apiKey) throw new Error('NO_API_KEY');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API 调用失败: ${response.status} ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content || '';
  const tokens = data.usage?.total_tokens || Math.ceil(text.length / 4);
  const cost = tokens * 0.0000005;
  return { text, tokens, cost, model };
}

async function callCodex(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'codex',
      ['exec', '-C', cwd || process.cwd(), '-s', 'read-only', '--skip-git-repo-check', '-'],
      { cwd: cwd || process.cwd(), env: process.env, windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex 规划超时'));
    }, 180_000);
    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || `codex exit ${code}`));
      else resolve(stdout);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function generatePlan(
  project: Project,
  options: { preferApi?: boolean; useCodex?: boolean } = {}
): Promise<{ plan: PlanOutput; source: string }> {
  const started = Date.now();
  const useCodex =
    options.useCodex === true || process.env.AI_CC_USE_CODEX === '1';

  try {
    if (options.preferApi !== false) {
      const result = await callOpenAICompatible(buildPlanPrompt(project), '你是资深技术项目经理与架构师。');
      const plan = normalizePlan(extractJson<PlanOutput>(result.text), project);
      recordCost({
        projectId: project.id,
        agent: 'gpt',
        model: result.model,
        tokens: result.tokens,
        cost: result.cost,
        durationMs: Date.now() - started
      });
      return { plan, source: 'api' };
    }
  } catch (error) {
    if ((error as Error).message !== 'NO_API_KEY') {
      // fall through to codex/local
    }
  }

  if (useCodex) {
    try {
      const text = await callCodex(buildPlanPrompt(project), project.root_path || process.cwd());
      const plan = normalizePlan(extractJson<PlanOutput>(text), project);
      recordCost({
        projectId: project.id,
        agent: 'gpt',
        model: 'codex-cli',
        tokens: Math.ceil(text.length / 4),
        cost: 0,
        durationMs: Date.now() - started
      });
      return { plan, source: 'codex' };
    } catch {
      // fall through to local
    }
  }

  const plan = localFallbackPlan(project);
  recordCost({
    projectId: project.id,
    agent: 'gpt',
    model: 'local-fallback',
    tokens: 0,
    cost: 0,
    durationMs: Date.now() - started,
    status: 'fallback'
  });
  return { plan, source: 'local-fallback' };
}

export async function generateReview(input: {
  project: Project;
  task: Task;
  run: Run;
}): Promise<{ review: ReviewOutput; source: string }> {
  const started = Date.now();
  try {
    const result = await callOpenAICompatible(
      buildReviewPrompt(input),
      '你是严格但务实的代码审查员。'
    );
    const review = normalizeReview(extractJson<ReviewOutput>(result.text));
    recordCost({
      projectId: input.project.id,
      taskId: input.task.id,
      agent: 'gpt',
      model: result.model,
      tokens: result.tokens,
      cost: result.cost,
      durationMs: Date.now() - started
    });
    return { review, source: 'api' };
  } catch {
    const review = localFallbackReview(input.task, input.run);
    recordCost({
      projectId: input.project.id,
      taskId: input.task.id,
      agent: 'gpt',
      model: 'local-fallback',
      tokens: 0,
      cost: 0,
      durationMs: Date.now() - started,
      status: 'fallback'
    });
    return { review, source: 'local-fallback' };
  }
}

function normalizePlan(plan: PlanOutput, project: Project): PlanOutput {
  if (!plan.tasks || plan.tasks.length < 1) return localFallbackPlan(project);
  return {
    summary: plan.summary || project.goal,
    userStories: plan.userStories || [],
    architecture: plan.architecture || '',
    risks: plan.risks || [],
    acceptanceCriteria: plan.acceptanceCriteria || [],
    recommendedAgents: plan.recommendedAgents || ['shell', 'gpt'],
    tasks: plan.tasks.slice(0, 40).map((t, index) => ({
      title: String(t.title || `任务 ${index + 1}`).slice(0, 180),
      goal: String(t.goal || t.title || '').slice(0, 4000),
      priority: t.priority ?? index + 1,
      assignedAgent: ['shell', 'http', 'gpt'].includes(t.assignedAgent || '')
        ? t.assignedAgent
        : 'shell',
      dependencies: t.dependencies || [],
      acceptanceCriteria: t.acceptanceCriteria || [],
      allowedPaths: t.allowedPaths || ['**/*'],
      allowedCommands: t.allowedCommands || ['node --test', 'npm test']
    }))
  };
}

function normalizeReview(review: ReviewOutput): ReviewOutput {
  const status = ['passed', 'conditional', 'needs_changes'].includes(review.status)
    ? review.status
    : 'conditional';
  return {
    status,
    score: Number.isFinite(review.score) ? review.score : 70,
    findings: Array.isArray(review.findings) ? review.findings : [],
    repairTasks: Array.isArray(review.repairTasks) ? review.repairTasks : [],
    summary: review.summary || '',
    riskLevel: review.riskLevel || 'low'
  };
}

export function chatgptAssistBundle(project: Project): {
  prompt: string;
  importHint: string;
} {
  return {
    prompt: buildPlanPrompt(project),
    importHint: '将 ChatGPT 返回的 JSON 粘贴到「导入计划」中。'
  };
}
