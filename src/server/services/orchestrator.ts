import fs from 'node:fs';
import path from 'node:path';
import { chatgptAssistBundle, generatePlan } from '../agents/gpt.ts';
import { dispatchTask } from '../agents/gateway.ts';
import type { PlanOutput, Project } from '../types.ts';
import { requestApproval, resolveApproval } from './approvals.ts';
import { projectCostSummary } from './cost.ts';
import { emitEvent } from './events.ts';
import { evaluateBudget } from './policy.ts';
import {
  createTasksFromPlan,
  getTask,
  incrementRetry,
  listTasks,
  refreshReadyTasks,
  updateTaskStatus
} from './task-graph.ts';
import { ensureDocsDir, getPlan, getProject, savePlan, updateProject } from './project.ts';
import { reviewTask } from './review.ts';
import { latestRun } from './runner.ts';

export async function planProject(projectId: string): Promise<{
  plan: PlanOutput;
  source: string;
  assist?: { prompt: string; importHint: string };
}> {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');

  const { plan, source } = await generatePlan(project);
  savePlan(projectId, plan, 'draft');
  writePlanArtifacts(project, plan);

  const assist =
    source === 'local-fallback' || project.gpt_mode === 'chatgpt_assist'
      ? chatgptAssistBundle(project)
      : undefined;

  return { plan, source, assist };
}

export function importPlan(projectId: string, plan: PlanOutput): PlanOutput {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');
  if (!plan.tasks?.length) throw new Error('计划需要包含任务');
  savePlan(projectId, plan, 'draft');
  writePlanArtifacts(project, plan);
  return plan;
}

export function approvePlan(projectId: string) {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');
  const plan = getPlan(projectId);
  if (!plan) throw new Error('请先生成计划');

  savePlan(projectId, plan, 'approved');
  const tasks = createTasksFromPlan(projectId, plan);
  emitEvent(projectId, 'plan_approved', `批准计划并创建 ${tasks.length} 个任务`);
  updateProject(projectId, { stage: 'execution' });
  return { project: getProject(projectId)!, tasks };
}

function writePlanArtifacts(project: Project, plan: PlanOutput): void {
  const docs = ensureDocsDir(project);
  if (!docs) return;
  fs.writeFileSync(path.join(docs, 'plan.json'), JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(docs, 'architecture.md'),
    `# Architecture\n\n${plan.architecture}\n\n## Summary\n\n${plan.summary}\n`
  );
}

export async function runNextReadyTasks(projectId: string, limit = 1): Promise<unknown[]> {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');
  refreshReadyTasks(projectId);
  const ready = listTasks(projectId).filter((t) => t.status === 'ready').slice(0, limit);
  const results = [];
  for (const task of ready) {
    results.push(await runSingleTask(task.id));
  }
  return results;
}

export async function runSingleTask(taskId: string): Promise<unknown> {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  const project = getProject(task.project_id);
  if (!project) throw new Error('项目不存在');

  const cost = projectCostSummary(project.id);
  const budget = evaluateBudget(cost.spent, project.budget_limit, 0.05);
  if (budget.requiresApproval) {
    requestApproval({
      projectId: project.id,
      taskId: task.id,
      action: budget.action,
      riskLevel: budget.risk,
      description: budget.reason
    });
    updateTaskStatus(task.id, 'planned', '等待预算审批');
    return { blocked: true, reason: budget.reason };
  }

  const result = await dispatchTask(taskId);

  if (result.status === 'needs_approval' && result.approvalAction) {
    requestApproval({
      projectId: project.id,
      taskId: task.id,
      action: result.approvalAction,
      riskLevel: result.approvalRisk || 'medium',
      description: result.approvalDescription || result.summary
    });
  }

  if (result.status === 'completed' && getTask(taskId)?.status === 'review') {
    await reviewTask(taskId);
  }

  if (result.status === 'failed') {
    const current = getTask(taskId)!;
    if (current.retry_count < current.max_retries) {
      incrementRetry(taskId);
      updateTaskStatus(taskId, 'ready', '准备重试');
      emitEvent(project.id, 'progress_updated', `任务「${task.title}」将重试`, taskId);
    }
  }

  return { result, run: latestRun(taskId), task: getTask(taskId) };
}

export function finalizeProject(projectId: string): {
  report: string;
  path: string | null;
} {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');
  const tasks = listTasks(projectId);
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const cost = projectCostSummary(projectId);
  const report = `# ${project.name} 版本报告

生成时间：${new Date().toLocaleString('zh-CN')}

## 目标
${project.goal}

## 进度
- 任务总数：${tasks.length}
- 已完成：${done}
- 失败：${failed}
- 项目阶段：${project.stage}

## 成本
- 已用：$${cost.spent.toFixed(4)} / 预算 $${cost.limit}
- 分 Agent：${JSON.stringify(cost.byAgent)}

## 任务清单
${tasks.map((t) => `- [${t.status}] ${t.title} (${t.assigned_agent || 'unassigned'})`).join('\n')}
`;

  const docs = ensureDocsDir(project);
  let reportPath: string | null = null;
  if (docs) {
    reportPath = path.join(docs, 'release-report.md');
    fs.writeFileSync(reportPath, report);
  }
  updateProject(projectId, { stage: 'delivered' });
  emitEvent(projectId, 'artifact_created', '生成版本报告', null, { reportPath });
  return { report, path: reportPath };
}

export function approveAndContinue(approvalId: string, approved: boolean) {
  const approval = resolveApproval(approvalId, approved ? 'approved' : 'rejected');
  if (approved && approval.task_id) {
    updateTaskStatus(approval.task_id, 'ready', '审批通过，可继续执行');
  }
  return approval;
}
