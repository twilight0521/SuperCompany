import fs from 'node:fs';
import path from 'node:path';
import { db, newId, nowIso, parseJson } from '../db/client.ts';
import type { PlanOutput, Project } from '../types.ts';
import { emitEvent } from './events.ts';

export function listProjects(): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as Project[];
}

export function getProject(id: string): Project | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project | undefined) ?? null;
}

export function createProject(input: {
  name: string;
  description?: string;
  goal?: string;
  projectType?: string;
  techStack?: string;
  rootPath?: string;
  repositoryUrl?: string;
  budgetLimit?: number;
  gptMode?: Project['gpt_mode'];
}): Project {
  const name = input.name.trim();
  if (!name) throw new Error('项目名称不能为空');

  const rootPath = (input.rootPath || '').trim();
  if (rootPath) {
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      throw new Error('本地代码目录不存在');
    }
  }

  const now = nowIso();
  const project: Project = {
    id: newId('project'),
    name,
    description: (input.description || '').trim(),
    goal: (input.goal || '').trim(),
    project_type: input.projectType || 'code',
    tech_stack: (input.techStack || '').trim(),
    root_path: rootPath,
    repository_url: (input.repositoryUrl || '').trim(),
    budget_limit: input.budgetLimit ?? 10,
    spent: 0,
    stage: 'intake',
    plan_json: null,
    plan_status: 'none',
    gpt_mode: input.gptMode || 'hybrid',
    created_at: now,
    updated_at: now
  };

  db.prepare(
    `INSERT INTO projects (
      id, name, description, goal, project_type, tech_stack, root_path, repository_url,
      budget_limit, spent, stage, plan_json, plan_status, gpt_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    project.id,
    project.name,
    project.description,
    project.goal,
    project.project_type,
    project.tech_stack,
    project.root_path,
    project.repository_url,
    project.budget_limit,
    project.spent,
    project.stage,
    project.plan_json,
    project.plan_status,
    project.gpt_mode,
    project.created_at,
    project.updated_at
  );

  emitEvent(project.id, 'project_created', `创建项目「${project.name}」`);
  return project;
}

export function updateProject(
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    goal: string;
    projectType: string;
    techStack: string;
    rootPath: string;
    repositoryUrl: string;
    budgetLimit: number;
    stage: string;
    gptMode: Project['gpt_mode'];
  }>
): Project {
  const project = getProject(id);
  if (!project) throw new Error('项目不存在');

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('项目名称不能为空');
    project.name = name;
  }
  if (patch.description !== undefined) project.description = patch.description.trim();
  if (patch.goal !== undefined) project.goal = patch.goal.trim();
  if (patch.projectType !== undefined) project.project_type = patch.projectType;
  if (patch.techStack !== undefined) project.tech_stack = patch.techStack.trim();
  if (patch.rootPath !== undefined) {
    const rootPath = patch.rootPath.trim();
    if (rootPath && (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory())) {
      throw new Error('本地代码目录不存在');
    }
    project.root_path = rootPath;
  }
  if (patch.repositoryUrl !== undefined) project.repository_url = patch.repositoryUrl.trim();
  if (patch.budgetLimit !== undefined) project.budget_limit = patch.budgetLimit;
  if (patch.stage !== undefined) project.stage = patch.stage;
  if (patch.gptMode !== undefined) project.gpt_mode = patch.gptMode;
  project.updated_at = nowIso();

  db.prepare(
    `UPDATE projects SET
      name = ?, description = ?, goal = ?, project_type = ?, tech_stack = ?, root_path = ?,
      repository_url = ?, budget_limit = ?, stage = ?, gpt_mode = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    project.name,
    project.description,
    project.goal,
    project.project_type,
    project.tech_stack,
    project.root_path,
    project.repository_url,
    project.budget_limit,
    project.stage,
    project.gpt_mode,
    project.updated_at,
    project.id
  );

  return project;
}

export function savePlan(projectId: string, plan: PlanOutput, status: Project['plan_status'] = 'draft'): Project {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');
  project.plan_json = JSON.stringify(plan);
  project.plan_status = status;
  project.stage = status === 'approved' ? 'execution' : 'planning';
  project.updated_at = nowIso();
  db.prepare(
    `UPDATE projects SET plan_json = ?, plan_status = ?, stage = ?, updated_at = ? WHERE id = ?`
  ).run(project.plan_json, project.plan_status, project.stage, project.updated_at, project.id);
  emitEvent(projectId, 'plan_created', `生成项目计划（${plan.tasks.length} 个任务）`, null, {
    taskCount: plan.tasks.length
  });
  return project;
}

export function getPlan(projectId: string): PlanOutput | null {
  const project = getProject(projectId);
  if (!project?.plan_json) return null;
  return parseJson<PlanOutput | null>(project.plan_json, null);
}

export function ensureDocsDir(project: Project): string | null {
  if (!project.root_path) return null;
  const docs = path.join(project.root_path, 'docs', 'ai-command-center');
  fs.mkdirSync(docs, { recursive: true });
  return docs;
}
