import { db, newId, nowIso } from '../db/client.ts';
import type { CostRecord } from '../types.ts';
import { emitEvent } from './events.ts';

export function recordCost(input: {
  projectId: string;
  taskId?: string | null;
  agent: string;
  model?: string;
  tokens?: number;
  cost: number;
  durationMs?: number;
  status?: string;
}): CostRecord {
  const row: CostRecord = {
    id: newId('cost'),
    project_id: input.projectId,
    task_id: input.taskId ?? null,
    agent: input.agent,
    model: input.model ?? '',
    tokens: input.tokens ?? 0,
    cost: input.cost,
    duration_ms: input.durationMs ?? 0,
    status: input.status ?? 'ok',
    created_at: nowIso()
  };

  db.prepare(
    `INSERT INTO costs (id, project_id, task_id, agent, model, tokens, cost, duration_ms, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.project_id,
    row.task_id,
    row.agent,
    row.model,
    row.tokens,
    row.cost,
    row.duration_ms,
    row.status,
    row.created_at
  );

  db.prepare('UPDATE projects SET spent = spent + ?, updated_at = ? WHERE id = ?').run(
    row.cost,
    nowIso(),
    input.projectId
  );

  emitEvent(
    input.projectId,
    'cost_recorded',
    `${input.agent} 产生费用 $${row.cost.toFixed(4)}`,
    input.taskId ?? null,
    { cost: row.cost, tokens: row.tokens, model: row.model }
  );

  return row;
}

export function listCosts(projectId: string): CostRecord[] {
  return db
    .prepare('SELECT * FROM costs WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as unknown as CostRecord[];
}

export function projectCostSummary(projectId: string): {
  spent: number;
  limit: number;
  byAgent: Record<string, number>;
} {
  const project = db.prepare('SELECT spent, budget_limit FROM projects WHERE id = ?').get(projectId) as unknown as
    | { spent: number; budget_limit: number }
    | undefined;
  const rows = db
    .prepare('SELECT agent, SUM(cost) as total FROM costs WHERE project_id = ? GROUP BY agent')
    .all(projectId) as unknown as Array<{ agent: string; total: number }>;
  const byAgent: Record<string, number> = {};
  for (const row of rows) byAgent[row.agent] = row.total;
  return {
    spent: project?.spent ?? 0,
    limit: project?.budget_limit ?? 0,
    byAgent
  };
}
