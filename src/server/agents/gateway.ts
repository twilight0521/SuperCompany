import type { AgentCapability, AgentTaskRequest, AgentTaskResult } from '../types.ts';
import { executeShellTask, latestRun } from '../services/runner.ts';
import { runHttpAgent } from './http.ts';
import { generateReview } from './gpt.ts';
import { getProject } from '../services/project.ts';
import { getTask, updateTaskStatus } from '../services/task-graph.ts';
import { db, newId, nowIso } from '../db/client.ts';
import { recordCost } from '../services/cost.ts';
import { emitEvent } from '../services/events.ts';

export const agents: AgentCapability[] = [
  {
    id: 'gpt',
    name: 'GPT 总指挥',
    kind: 'gpt',
    task_types: ['plan', 'review'],
    can_read_files: true,
    can_write_files: false,
    can_run_commands: false,
    supports_streaming: false,
    supports_structured: true,
    estimated_cost: 0.05,
    location: 'remote',
    description: '规划、架构、Review 与验收'
  },
  {
    id: 'shell',
    name: 'Shell Agent',
    kind: 'shell',
    task_types: ['code', 'test', 'docs'],
    can_read_files: true,
    can_write_files: true,
    can_run_commands: true,
    supports_streaming: true,
    supports_structured: false,
    estimated_cost: 0.01,
    location: 'local',
    description: '本地命令、文件修改、测试执行（Git Worktree 隔离）'
  },
  {
    id: 'http',
    name: 'HTTP Agent',
    kind: 'http',
    task_types: ['fetch', 'api'],
    can_read_files: false,
    can_write_files: true,
    can_run_commands: false,
    supports_streaming: false,
    supports_structured: true,
    estimated_cost: 0.001,
    location: 'remote',
    description: '通用 HTTP/API 调用'
  },
  {
    id: 'manual',
    name: '人工接管',
    kind: 'manual',
    task_types: ['any'],
    can_read_files: true,
    can_write_files: true,
    can_run_commands: true,
    supports_streaming: false,
    supports_structured: false,
    estimated_cost: 0,
    location: 'local',
    description: 'Agent 不可用时由用户手动完成并回填结果'
  }
];

export function getAgent(id: string): AgentCapability | undefined {
  return agents.find((a) => a.id === id);
}

export async function dispatchTask(taskId: string): Promise<AgentTaskResult> {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'ready' && task.status !== 'needs_changes') {
    throw new Error(`任务状态为 ${task.status}，无法执行`);
  }
  const project = getProject(task.project_id);
  if (!project) throw new Error('项目不存在');
  if (!project.root_path) throw new Error('请先绑定本地代码目录');

  const agentId = task.assigned_agent || 'shell';
  updateTaskStatus(taskId, 'running');

  const request: AgentTaskRequest = {
    taskId: task.id,
    projectId: project.id,
    title: task.title,
    goal: task.goal,
    contextRefs: [],
    allowedPaths: task.allowedPaths,
    allowedCommands: task.allowedCommands,
    acceptanceCriteria: task.acceptance,
    rootPath: project.root_path,
    budget: { maxTokens: 12_000, maxCost: task.budget_limit }
  };

  if (agentId === 'http') {
    const result = await runHttpAgent(request);
    persistAgentResult(task.id, 'http', result);
    recordCost({
      projectId: project.id,
      taskId: task.id,
      agent: 'http',
      cost: result.cost,
      status: result.status
    });
    updateTaskStatus(task.id, result.status === 'completed' ? 'review' : 'failed', result.summary);
    return result;
  }

  if (agentId === 'gpt') {
    const run = latestRun(task.id);
    const synthetic = run || {
      id: newId('run'),
      task_id: task.id,
      agent_id: 'gpt',
      worktree_path: project.root_path,
      started_at: nowIso(),
      finished_at: nowIso(),
      exit_code: 0,
      cost: 0,
      status: 'completed',
      log: 'GPT Review 任务：汇总项目当前状态',
      diff: '',
      test_output: ''
    };
    if (!run) {
      db.prepare(
        `INSERT INTO runs (id, task_id, agent_id, worktree_path, started_at, finished_at, exit_code, cost, status, log, diff, test_output)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        synthetic.id,
        synthetic.task_id,
        synthetic.agent_id,
        synthetic.worktree_path,
        synthetic.started_at,
        synthetic.finished_at,
        synthetic.exit_code,
        synthetic.cost,
        synthetic.status,
        synthetic.log,
        synthetic.diff,
        synthetic.test_output
      );
    }
    const { review, source } = await generateReview({ project, task, run: synthetic });
    db.prepare(
      `INSERT INTO reviews (id, task_id, reviewer, status, score, findings, repair_tasks, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId('review'),
      task.id,
      `gpt:${source}`,
      review.status,
      review.score,
      JSON.stringify(review.findings),
      JSON.stringify(review.repairTasks),
      review.summary,
      nowIso()
    );
    emitEvent(project.id, 'review_completed', `GPT Review：${review.status} (${review.score})`, task.id, {
      ...review
    });
    const ok = review.status === 'passed' || review.status === 'conditional';
    updateTaskStatus(task.id, ok ? 'done' : 'needs_changes', review.summary);
    return {
      status: ok ? 'completed' : 'failed',
      summary: review.summary,
      log: JSON.stringify(review, null, 2),
      diff: '',
      testOutput: '',
      exitCode: ok ? 0 : 1,
      cost: 0,
      artifacts: []
    };
  }

  if (agentId === 'manual') {
    updateTaskStatus(task.id, 'review', '等待人工回填结果');
    return {
      status: 'needs_approval',
      summary: '已切换人工接管，请在任务详情回填结果',
      log: '',
      diff: '',
      testOutput: '',
      exitCode: 0,
      cost: 0,
      artifacts: [],
      approvalAction: 'manual.takeover',
      approvalRisk: 'medium',
      approvalDescription: `任务「${task.title}」需要人工接管`
    };
  }

  const run = await executeShellTask({
    projectId: project.id,
    taskId: task.id,
    agentId: 'shell',
    rootPath: project.root_path,
    goal: task.goal,
    allowedCommands: task.allowedCommands,
    timeoutMs: task.timeout_ms,
    useWorktree: true
  });
  recordCost({
    projectId: project.id,
    taskId: task.id,
    agent: 'shell',
    cost: run.cost,
    status: run.status
  });
  updateTaskStatus(task.id, run.status === 'completed' ? 'review' : 'failed', run.log.slice(0, 500));
  return {
    status: run.status === 'completed' ? 'completed' : 'failed',
    summary: run.status === 'completed' ? 'Shell 任务完成，待 Review' : 'Shell 任务失败',
    log: run.log,
    diff: run.diff,
    testOutput: run.test_output,
    exitCode: run.exit_code ?? 1,
    cost: run.cost,
    artifacts: []
  };
}

function persistAgentResult(taskId: string, agentId: string, result: AgentTaskResult): void {
  db.prepare(
    `INSERT INTO runs (id, task_id, agent_id, worktree_path, started_at, finished_at, exit_code, cost, status, log, diff, test_output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('run'),
    taskId,
    agentId,
    null,
    nowIso(),
    nowIso(),
    result.exitCode,
    result.cost,
    result.status,
    result.log,
    result.diff,
    result.testOutput
  );
}
