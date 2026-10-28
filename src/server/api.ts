import type { IncomingMessage, ServerResponse } from 'node:http';
import { agents, getAgent } from './agents/gateway.ts';
import { chatgptAssistBundle } from './agents/gpt.ts';
import { getSetting, setSetting } from './db/client.ts';
import { listApprovals } from './services/approvals.ts';
import { listCosts, projectCostSummary } from './services/cost.ts';
import { listEvents } from './services/events.ts';
import {
  approveAndContinue,
  approvePlan,
  finalizeProject,
  importPlan,
  planProject,
  runNextReadyTasks,
  runSingleTask
} from './services/orchestrator.ts';
import {
  createProject,
  getPlan,
  getProject,
  listProjects,
  updateProject
} from './services/project.ts';
import { listReviews, reviewTask } from './services/review.ts';
import { latestRun, listRuns } from './services/runner.ts';
import {
  getTask,
  listTasks,
  taskGraphView,
  updateTaskStatus
} from './services/task-graph.ts';
import type { PlanOutput } from './types.ts';

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 2_000_000) throw new Error('请求过大');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  send(res, 404, { error: '接口不存在' });
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const method = req.method || 'GET';
    const parts = url.pathname.split('/').filter(Boolean);

    if (method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && url.pathname === '/api/bootstrap') {
      return send(res, 200, {
        agents,
        settings: {
          hasApiKey: Boolean(process.env.OPENAI_API_KEY || getSetting('openai_api_key')),
          openaiBaseUrl: getSetting('openai_base_url', 'https://api.openai.com/v1'),
          openaiModel: getSetting('openai_model', 'gpt-4o-mini')
        }
      });
    }

    if (method === 'POST' && url.pathname === '/api/settings') {
      const body = (await readBody(req)) as Record<string, string>;
      if (body.openaiApiKey !== undefined) setSetting('openai_api_key', body.openaiApiKey);
      if (body.openaiBaseUrl !== undefined) setSetting('openai_base_url', body.openaiBaseUrl);
      if (body.openaiModel !== undefined) setSetting('openai_model', body.openaiModel);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && url.pathname === '/api/projects') {
      return send(res, 200, { projects: listProjects() });
    }

    if (method === 'POST' && url.pathname === '/api/projects') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const project = createProject({
        name: String(body.name || ''),
        description: String(body.description || ''),
        goal: String(body.goal || ''),
        projectType: String(body.projectType || 'code'),
        techStack: String(body.techStack || ''),
        rootPath: String(body.rootPath || ''),
        repositoryUrl: String(body.repositoryUrl || ''),
        budgetLimit: Number(body.budgetLimit ?? 10),
        gptMode: (body.gptMode as 'api' | 'chatgpt_assist' | 'hybrid') || 'hybrid'
      });
      return send(res, 201, project);
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && parts.length === 3) {
      const project = getProject(parts[2]);
      if (!project) return send(res, 404, { error: '项目不存在' });
      if (method === 'GET') {
        return send(res, 200, {
          project,
          plan: getPlan(project.id),
          tasks: listTasks(project.id),
          graph: taskGraphView(project.id),
          events: listEvents(project.id),
          approvals: listApprovals(project.id),
          costs: projectCostSummary(project.id)
        });
      }
      if (method === 'PATCH') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const updated = updateProject(project.id, {
          name: body.name as string | undefined,
          description: body.description as string | undefined,
          goal: body.goal as string | undefined,
          projectType: body.projectType as string | undefined,
          techStack: body.techStack as string | undefined,
          rootPath: body.rootPath as string | undefined,
          repositoryUrl: body.repositoryUrl as string | undefined,
          budgetLimit: body.budgetLimit as number | undefined,
          stage: body.stage as string | undefined,
          gptMode: body.gptMode as ProjectGptMode | undefined
        });
        return send(res, 200, updated);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'plan' && parts.length === 4) {
      const projectId = parts[2];
      if (method === 'POST') {
        const result = await planProject(projectId);
        return send(res, 200, result);
      }
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'import-plan' && parts.length === 4) {
      if (method === 'POST') {
        const body = (await readBody(req)) as { plan: PlanOutput };
        const plan = importPlan(parts[2], body.plan);
        return send(res, 200, { plan });
      }
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'approve-plan' && parts.length === 4) {
      if (method === 'POST') {
        return send(res, 200, approvePlan(parts[2]));
      }
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'assist-prompt' && parts.length === 4) {
      if (method === 'GET') {
        const project = getProject(parts[2]);
        if (!project) return send(res, 404, { error: '项目不存在' });
        return send(res, 200, chatgptAssistBundle(project));
      }
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'run-next' && parts.length === 4) {
      if (method === 'POST') {
        const body = (await readBody(req)) as { limit?: number };
        const results = await runNextReadyTasks(parts[2], body.limit ?? 1);
        return send(res, 200, { results });
      }
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'finalize' && parts.length === 4) {
      if (method === 'POST') {
        return send(res, 200, finalizeProject(parts[2]));
      }
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'timeline' && parts.length === 4) {
      if (method === 'GET') return send(res, 200, { events: listEvents(parts[2]) });
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'costs' && parts.length === 4) {
      if (method === 'GET') {
        return send(res, 200, { summary: projectCostSummary(parts[2]), records: listCosts(parts[2]) });
      }
    }

    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'approvals' && parts.length === 4) {
      if (method === 'GET') return send(res, 200, { approvals: listApprovals(parts[2]) });
    }

    if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2] && parts.length === 3) {
      const task = getTask(parts[2]);
      if (!task) return send(res, 404, { error: '任务不存在' });
      if (method === 'GET') {
        return send(res, 200, {
          task,
          runs: listRuns(task.id),
          latestRun: latestRun(task.id),
          reviews: listReviews(task.id),
          agent: getAgent(task.assigned_agent || 'shell') || null
        });
      }
      if (method === 'PATCH') {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (body.status) {
          const updated = updateTaskStatus(task.id, body.status as never, String(body.summary || ''));
          return send(res, 200, updated);
        }
        return send(res, 400, { error: '无效更新' });
      }
    }

    if (parts[0] === 'api' && parts[1] === 'tasks' && parts[3] === 'run' && parts.length === 4) {
      if (method === 'POST') {
        return send(res, 200, await runSingleTask(parts[2]));
      }
    }

    if (parts[0] === 'api' && parts[1] === 'tasks' && parts[3] === 'review' && parts.length === 4) {
      if (method === 'POST') {
        return send(res, 200, await reviewTask(parts[2]));
      }
    }

    if (parts[0] === 'api' && parts[1] === 'approvals' && parts[2] && parts[3] === 'resolve' && parts.length === 4) {
      if (method === 'POST') {
        const body = (await readBody(req)) as { approved?: boolean };
        return send(res, 200, approveAndContinue(parts[2], body.approved !== false));
      }
    }

    return notFound(res);
  } catch (error) {
    send(res, 400, { error: (error as Error).message || '请求失败' });
  }
}

type ProjectGptMode = 'api' | 'chatgpt_assist' | 'hybrid';
