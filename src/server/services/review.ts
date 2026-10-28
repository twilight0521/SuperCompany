import { db, newId, nowIso } from '../db/client.ts';
import type { Review, ReviewOutput } from '../types.ts';
import { generateReview } from '../agents/gpt.ts';
import { getProject } from './project.ts';
import { createRepairTasks, getTask, updateTaskStatus } from './task-graph.ts';
import { latestRun } from './runner.ts';
import { emitEvent } from './events.ts';

export function listReviews(taskId: string): Review[] {
  return db
    .prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC')
    .all(taskId) as unknown as Review[];
}

export async function reviewTask(taskId: string): Promise<{ review: ReviewOutput; source: string }> {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  const project = getProject(task.project_id);
  if (!project) throw new Error('项目不存在');
  const run = latestRun(taskId);
  if (!run) throw new Error('没有可审查的执行记录');

  const { review, source } = await generateReview({ project, task, run });
  db.prepare(
    `INSERT INTO reviews (id, task_id, reviewer, status, score, findings, repair_tasks, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('review'),
    taskId,
    `gpt:${source}`,
    review.status,
    review.score,
    JSON.stringify(review.findings),
    JSON.stringify(review.repairTasks),
    review.summary,
    nowIso()
  );

  emitEvent(project.id, 'review_completed', `Review ${review.status}（${review.score}）`, taskId, {
    ...review
  });

  if (review.status === 'needs_changes') {
    updateTaskStatus(taskId, 'needs_changes', review.summary);
    if (review.repairTasks.length) {
      createRepairTasks(project.id, taskId, review.repairTasks.slice(0, 5));
    }
  } else {
    updateTaskStatus(taskId, 'done', review.summary);
  }

  return { review, source };
}
