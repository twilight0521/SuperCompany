import { db, newId, nowIso } from '../db/client.ts';
import type { Approval, ApprovalStatus, RiskLevel } from '../types.ts';
import { emitEvent } from './events.ts';

export function listApprovals(projectId: string, status?: ApprovalStatus): Approval[] {
  if (status) {
    return db
      .prepare('SELECT * FROM approvals WHERE project_id = ? AND status = ? ORDER BY created_at DESC')
      .all(projectId, status) as unknown as Approval[];
  }
  return db
    .prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as unknown as Approval[];
}

export function getApproval(id: string): Approval | null {
  return (db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as Approval | undefined) ?? null;
}

export function requestApproval(input: {
  projectId: string;
  taskId?: string | null;
  action: string;
  riskLevel: RiskLevel;
  description: string;
}): Approval {
  const approval: Approval = {
    id: newId('approval'),
    project_id: input.projectId,
    task_id: input.taskId ?? null,
    action: input.action,
    risk_level: input.riskLevel,
    description: input.description,
    status: 'pending',
    approved_by: null,
    created_at: nowIso(),
    resolved_at: null
  };
  db.prepare(
    `INSERT INTO approvals (id, project_id, task_id, action, risk_level, description, status, approved_by, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    approval.id,
    approval.project_id,
    approval.task_id,
    approval.action,
    approval.risk_level,
    approval.description,
    approval.status,
    approval.approved_by,
    approval.created_at,
    approval.resolved_at
  );
  emitEvent(
    input.projectId,
    'approval_required',
    `需要审批：${input.description}`,
    input.taskId ?? null,
    { approvalId: approval.id, risk: input.riskLevel, action: input.action }
  );
  return approval;
}

export function resolveApproval(
  id: string,
  status: Exclude<ApprovalStatus, 'pending'>,
  approvedBy = 'user'
): Approval {
  const approval = getApproval(id);
  if (!approval) throw new Error('审批不存在');
  if (approval.status !== 'pending') throw new Error('审批已处理');
  approval.status = status;
  approval.approved_by = approvedBy;
  approval.resolved_at = nowIso();
  db.prepare(
    `UPDATE approvals SET status = ?, approved_by = ?, resolved_at = ? WHERE id = ?`
  ).run(approval.status, approval.approved_by, approval.resolved_at, approval.id);
  emitEvent(
    approval.project_id,
    'approval_resolved',
    `审批${status === 'approved' ? '通过' : '拒绝'}：${approval.description}`,
    approval.task_id,
    { approvalId: approval.id, status }
  );
  return approval;
}
