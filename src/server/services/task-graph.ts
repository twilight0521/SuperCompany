import { db, newId, nowIso, parseJson } from '../db/client.ts';
import type { PlanOutput, Task, TaskStatus } from '../types.ts';
import { emitEvent } from './events.ts';

function mapTask(row: Task): Task & {
  dependencyIds: string[];
  acceptance: string[];
  allowedPaths: string[];
  allowedCommands: string[];
} {
  return {
    ...row,
    dependencyIds: parseJson<string[]>(row.dependencies, []),
    acceptance: parseJson<string[]>(row.acceptance_criteria, []),
    allowedPaths: parseJson<string[]>(row.allowed_paths, []),
    allowedCommands: parseJson<string[]>(row.allowed_commands, [])
  };
}

export function listTasks(projectId: string) {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC')
    .all(projectId) as unknown as Task[];
  return rows.map(mapTask);
}

export function getTask(id: string) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Task | undefined;
  return row ? mapTask(row) : null;
}

export function createTasksFromPlan(projectId: string, plan: PlanOutput): Task[] {
  const existing = listTasks(projectId);
  if (existing.length > 0) {
    throw new Error('项目已有任务，请先清空或继续现有任务');
  }

  const titleToId = new Map<string, string>();
  const created: Task[] = [];
  const now = nowIso();

  for (const [index, item] of plan.tasks.entries()) {
    const id = newId('task');
    titleToId.set(item.title, id);
    const task: Task = {
      id,
      project_id: projectId,
      parent_id: null,
      title: item.title,
      goal: item.goal,
      status: 'planned',
      priority: item.priority ?? index + 1,
      assigned_agent: item.assignedAgent || suggestAgent(item.title, item.goal),
      dependencies: '[]',
      acceptance_criteria: JSON.stringify(item.acceptanceCriteria || []),
      allowed_paths: JSON.stringify(item.allowedPaths || ['**/*']),
      allowed_commands: JSON.stringify(item.allowedCommands || ['npm test', 'npm run test', 'node --test']),
      input_files: '[]',
      output_files: '[]',
      budget_limit: 1,
      timeout_ms: 600_000,
      retry_count: 0,
      max_retries: 1,
      result_summary: '',
      created_at: now,
      completed_at: null
    };
    created.push(task);
  }

  for (const [index, item] of plan.tasks.entries()) {
    const deps = (item.dependencies || [])
      .map((title) => titleToId.get(title))
      .filter((id): id is string => Boolean(id));
    created[index].dependencies = JSON.stringify(deps);
  }

  const insert = db.prepare(
    `INSERT INTO tasks (
      id, project_id, parent_id, title, goal, status, priority, assigned_agent, dependencies,
      acceptance_criteria, allowed_paths, allowed_commands, input_files, output_files,
      budget_limit, timeout_ms, retry_count, max_retries, result_summary, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.exec('BEGIN');
  try {
    for (const task of created) {
      insert.run(
        task.id,
        task.project_id,
        task.parent_id,
        task.title,
        task.goal,
        task.status,
        task.priority,
        task.assigned_agent,
        task.dependencies,
        task.acceptance_criteria,
        task.allowed_paths,
        task.allowed_commands,
        task.input_files,
        task.output_files,
        task.budget_limit,
        task.timeout_ms,
        task.retry_count,
        task.max_retries,
        task.result_summary,
        task.created_at,
        task.completed_at
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  refreshReadyTasks(projectId);
  return listTasks(projectId);
}

export function suggestAgent(title: string, goal: string): string {
  const text = `${title} ${goal}`.toLowerCase();
  if (/review|审查|验收/.test(text)) return 'gpt';
  if (/http|api|请求|搜索/.test(text)) return 'http';
  return 'shell';
}

export function updateTaskStatus(taskId: string, status: TaskStatus, summary = ''): Task {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  const completedAt = status === 'done' ? nowIso() : null;
  db.prepare(
    `UPDATE tasks SET status = ?, result_summary = CASE WHEN ? = '' THEN result_summary ELSE ? END,
      completed_at = ?, retry_count = retry_count WHERE id = ?`
  ).run(status, summary, summary, completedAt, taskId);

  if (status === 'done' || status === 'failed') {
    emitEvent(
      task.project_id,
      status === 'done' ? 'task_completed' : 'task_failed',
      `任务「${task.title}」${status === 'done' ? '已完成' : '失败'}`,
      taskId
    );
    refreshReadyTasks(task.project_id);
  }
  return getTask(taskId)!;
}

export function incrementRetry(taskId: string): void {
  db.prepare('UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?').run(taskId);
}

export function refreshReadyTasks(projectId: string): void {
  const tasks = listTasks(projectId);
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  for (const task of tasks) {
    if (!['planned', 'ready', 'needs_changes'].includes(task.status)) continue;
    const deps = task.dependencyIds;
    const ready = deps.every((id) => done.has(id));
    const nextStatus: TaskStatus = ready ? 'ready' : 'planned';
    if (task.status !== 'needs_changes' && task.status !== nextStatus) {
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(nextStatus, task.id);
    }
  }
}

export function createRepairTasks(
  projectId: string,
  parentTaskId: string,
  repairs: string[],
  agent = 'shell'
): Task[] {
  const parent = getTask(parentTaskId);
  if (!parent) throw new Error('父任务不存在');
  const now = nowIso();
  const created: Task[] = [];
  for (const [index, title] of repairs.entries()) {
    const task: Task = {
      id: newId('task'),
      project_id: projectId,
      parent_id: parentTaskId,
      title,
      goal: title,
      status: 'ready',
      priority: parent.priority + index + 1,
      assigned_agent: agent,
      dependencies: JSON.stringify([]),
      acceptance_criteria: JSON.stringify([`修复：${title}`]),
      allowed_paths: parent.allowed_paths,
      allowed_commands: parent.allowed_commands,
      input_files: '[]',
      output_files: '[]',
      budget_limit: 1,
      timeout_ms: 600_000,
      retry_count: 0,
      max_retries: 1,
      result_summary: '',
      created_at: now,
      completed_at: null
    };
    db.prepare(
      `INSERT INTO tasks (
        id, project_id, parent_id, title, goal, status, priority, assigned_agent, dependencies,
        acceptance_criteria, allowed_paths, allowed_commands, input_files, output_files,
        budget_limit, timeout_ms, retry_count, max_retries, result_summary, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task.id,
      task.project_id,
      task.parent_id,
      task.title,
      task.goal,
      task.status,
      task.priority,
      task.assigned_agent,
      task.dependencies,
      task.acceptance_criteria,
      task.allowed_paths,
      task.allowed_commands,
      task.input_files,
      task.output_files,
      task.budget_limit,
      task.timeout_ms,
      task.retry_count,
      task.max_retries,
      task.result_summary,
      task.created_at,
      task.completed_at
    );
    created.push(task);
  }
  return created.map((t) => getTask(t.id)!);
}

export function taskGraphView(projectId: string) {
  const tasks = listTasks(projectId);
  return {
    nodes: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      agent: t.assigned_agent,
      priority: t.priority
    })),
    edges: tasks.flatMap((t) =>
      t.dependencyIds.map((from) => ({ from, to: t.id }))
    )
  };
}

export function clearProjectTasks(projectId: string): void {
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId);
}
