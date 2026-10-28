import fs from 'node:fs';
import path from 'node:path';
import type { AgentTaskRequest, AgentTaskResult } from '../types.ts';
import { emitEvent } from '../services/events.ts';

function extractUrl(goal: string): string | null {
  const match = goal.match(/https?:\/\/[^\s)]+/i);
  return match ? match[0].replace(/[.,;]+$/, '') : null;
}

export async function runHttpAgent(request: AgentTaskRequest): Promise<AgentTaskResult> {
  const url = extractUrl(request.goal) || 'https://httpbin.org/get';
  const started = Date.now();
  emitEvent(request.projectId, 'command_started', `HTTP GET ${url}`, request.taskId);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'AI-Command-Center/0.1' }
    });
    clearTimeout(timer);
    const text = await response.text();
    const body = text.slice(0, 4000);
    const summary = `HTTP ${response.status} ${url}`;
    const log = `${summary}\n\n${body}`;

    const cwd = request.worktreePath || request.rootPath;
    let artifacts: string[] = [];
    if (cwd && fs.existsSync(cwd)) {
      const outDir = path.join(cwd, 'docs', 'ai-command-center');
      fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, `http-${request.taskId}.json`);
      fs.writeFileSync(
        outFile,
        JSON.stringify(
          {
            url,
            status: response.status,
            ok: response.ok,
            fetchedAt: new Date().toISOString(),
            bodyPreview: body
          },
          null,
          2
        )
      );
      artifacts = [outFile];
      emitEvent(request.projectId, 'artifact_created', `写入 ${path.relative(cwd, outFile)}`, request.taskId);
    }

    emitEvent(
      request.projectId,
      response.ok ? 'task_completed' : 'task_failed',
      summary,
      request.taskId
    );

    return {
      status: response.ok ? 'completed' : 'failed',
      summary,
      log,
      diff: artifacts.length ? `A ${path.basename(artifacts[0])}` : '',
      testOutput: '',
      exitCode: response.ok ? 0 : 1,
      cost: 0.001,
      artifacts
    };
  } catch (error) {
    const message = (error as Error).message;
    emitEvent(request.projectId, 'task_failed', `HTTP 失败: ${message}`, request.taskId);
    return {
      status: 'failed',
      summary: message,
      log: message,
      diff: '',
      testOutput: '',
      exitCode: 1,
      cost: 0.001 * ((Date.now() - started) / 1000),
      artifacts: []
    };
  }
}
