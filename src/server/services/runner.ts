import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir, newId, nowIso } from '../db/client.ts';
import type { Run } from '../types.ts';
import { evaluateCommand } from './policy.ts';
import { emitEvent } from './events.ts';

export function getRun(id: string): Run | null {
  return (db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as Run | undefined) ?? null;
}

export function listRuns(taskId: string): Run[] {
  return db
    .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC')
    .all(taskId) as unknown as Run[];
}

export function latestRun(taskId: string): Run | null {
  return (
    (db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(taskId) as unknown as Run | undefined) ?? null
  );
}

function createRun(taskId: string, agentId: string, worktreePath: string | null): Run {
  const run: Run = {
    id: newId('run'),
    task_id: taskId,
    agent_id: agentId,
    worktree_path: worktreePath,
    started_at: nowIso(),
    finished_at: null,
    exit_code: null,
    cost: 0,
    status: 'running',
    log: '',
    diff: '',
    test_output: ''
  };
  db.prepare(
    `INSERT INTO runs (id, task_id, agent_id, worktree_path, started_at, finished_at, exit_code, cost, status, log, diff, test_output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    run.id,
    run.task_id,
    run.agent_id,
    run.worktree_path,
    run.started_at,
    run.finished_at,
    run.exit_code,
    run.cost,
    run.status,
    run.log,
    run.diff,
    run.test_output
  );
  return run;
}

function updateRun(run: Run): void {
  db.prepare(
    `UPDATE runs SET finished_at = ?, exit_code = ?, cost = ?, status = ?, log = ?, diff = ?, test_output = ?, worktree_path = ?
     WHERE id = ?`
  ).run(
    run.finished_at,
    run.exit_code,
    run.cost,
    run.status,
    run.log,
    run.diff,
    run.test_output,
    run.worktree_path,
    run.id
  );
}

function appendLog(run: Run, chunk: string): void {
  run.log = `${run.log}${chunk}`.slice(-200_000);
  db.prepare('UPDATE runs SET log = ? WHERE id = ?').run(run.log, run.id);
}

export async function ensureGitRepo(rootPath: string): Promise<boolean> {
  if (!rootPath || !fs.existsSync(rootPath)) return false;
  const gitDir = path.join(rootPath, '.git');
  if (fs.existsSync(gitDir)) return true;
  await runCommand(rootPath, 'git init', 30_000);
  await runCommand(rootPath, 'git add -A', 30_000);
  await runCommand(rootPath, 'git -c user.email=ai@local -c user.name=AICommand commit --allow-empty -m "init for AI command center"', 30_000);
  return true;
}

export async function createWorktree(projectId: string, taskId: string, rootPath: string): Promise<string> {
  await ensureGitRepo(rootPath);
  const branch = `ai-cc/${taskId.slice(-10)}`;
  const worktreePath = path.join(dataDir, 'worktrees', projectId, taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (fs.existsSync(worktreePath)) {
    await runCommand(rootPath, `git worktree remove --force "${worktreePath}"`, 30_000).catch(() => undefined);
  }
  await runCommand(rootPath, `git branch ${branch} 2>/dev/null || true`, 15_000).catch(() => undefined);
  const result = await runCommand(
    rootPath,
    `git worktree add -B ${branch} "${worktreePath}" HEAD`,
    60_000
  );
  if (result.exitCode !== 0) {
    // Fallback: copy workspace snapshot when worktree fails
    fs.cpSync(rootPath, worktreePath, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith('.git')
    });
  }
  return worktreePath;
}

export async function collectDiff(cwd: string): Promise<string> {
  const tracked = await runCommand(cwd, 'git diff --stat && git diff', 30_000);
  const untracked = await runCommand(cwd, 'git status --porcelain', 15_000);
  return `${tracked.stdout}\n${untracked.stdout}`.trim().slice(0, 100_000);
}

export async function runCommand(
  cwd: string,
  command: string,
  timeoutMs = 120_000,
  whitelist: string[] = []
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const decision = evaluateCommand(command, whitelist);
  if (!decision.allowed) {
    return { exitCode: 126, stdout: '', stderr: decision.reason };
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += '\n[timeout] 命令超时已终止\n';
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}

export async function executeShellTask(input: {
  projectId: string;
  taskId: string;
  agentId: string;
  rootPath: string;
  goal: string;
  allowedCommands: string[];
  timeoutMs: number;
  useWorktree?: boolean;
}): Promise<Run> {
  const worktreePath = input.useWorktree !== false
    ? await createWorktree(input.projectId, input.taskId, input.rootPath)
    : input.rootPath;

  const run = createRun(input.taskId, input.agentId, worktreePath);
  emitEvent(input.projectId, 'task_started', `Shell Agent 开始执行`, input.taskId, { runId: run.id });

  try {
    const markerDir = path.join(worktreePath, '.ai-command-center');
    fs.mkdirSync(markerDir, { recursive: true });
    const taskFile = path.join(markerDir, `${input.taskId}.md`);
    fs.writeFileSync(
      taskFile,
      `# ${input.taskId}\n\n## Goal\n\n${input.goal}\n\n## Allowed commands\n\n${input.allowedCommands.map((c) => `- ${c}`).join('\n')}\n`,
      'utf8'
    );
    emitEvent(input.projectId, 'file_changed', `写入任务说明 ${path.relative(worktreePath, taskFile)}`, input.taskId);

    const scriptPath = path.join(markerDir, `${input.taskId}.sh`);
    const script = buildHeuristicScript(input.goal, input.allowedCommands);
    fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o755 });

    emitEvent(input.projectId, 'command_started', `执行任务脚本`, input.taskId, { command: scriptPath });
    const result = await runCommand(worktreePath, `bash "${scriptPath}"`, input.timeoutMs, []);
    appendLog(run, result.stdout);
    if (result.stderr) appendLog(run, `\n[stderr]\n${result.stderr}`);
    emitEvent(input.projectId, 'command_finished', `命令结束 exit=${result.exitCode}`, input.taskId);

    let testOutput = '';
    for (const testCmd of input.allowedCommands.filter((c) => /test/i.test(c))) {
      emitEvent(input.projectId, 'command_started', `运行测试: ${testCmd}`, input.taskId);
      const testResult = await runCommand(worktreePath, testCmd, Math.min(input.timeoutMs, 180_000), input.allowedCommands);
      testOutput += `\n$ ${testCmd}\n${testResult.stdout}\n${testResult.stderr}\nexit=${testResult.exitCode}\n`;
      emitEvent(
        input.projectId,
        testResult.exitCode === 0 ? 'test_passed' : 'test_failed',
        `测试 ${testCmd} => ${testResult.exitCode}`,
        input.taskId
      );
      if (testResult.exitCode !== 0) break;
    }

    run.diff = await collectDiff(worktreePath);
    run.test_output = testOutput.trim();
    run.exit_code = result.exitCode;
    run.status = result.exitCode === 0 ? 'completed' : 'failed';
    run.finished_at = nowIso();
    run.cost = 0.01;
    updateRun(run);
    return run;
  } catch (error) {
    run.status = 'failed';
    run.exit_code = 1;
    run.finished_at = nowIso();
    appendLog(run, `\n[error] ${(error as Error).message}`);
    updateRun(run);
    return run;
  }
}

function buildHeuristicScript(goal: string, allowedCommands: string[]): string {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'echo "[ai-command-center] shell agent start"',
    `echo "goal: ${shellEscape(goal)}"`,
    'mkdir -p docs/ai-command-center artifacts',
  ];

  if (/readme|文档|document/i.test(goal)) {
    lines.push(
      'cat > docs/ai-command-center/TASK_NOTES.md <<\'EOF\'',
      `# Task Notes`,
      '',
      goal,
      '',
      'Generated by Shell Agent.',
      'EOF'
    );
  } else if (/test|测试/i.test(goal)) {
    lines.push(
      'mkdir -p test',
      'cat > test/smoke.test.mjs <<\'EOF\'',
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('smoke', () => { assert.equal(1 + 1, 2); });",
      'EOF'
    );
    if (allowedCommands.some((c) => c.includes('node --test'))) {
      lines.push('node --test test/smoke.test.mjs');
    }
  } else if (/初始化|init|scaffold|工程/i.test(goal)) {
    lines.push(
      'if [ ! -f package.json ]; then',
      '  printf \'%s\\n\' \'{"name":"ai-cc-workspace","version":"0.0.1","private":true,"type":"module","scripts":{"test":"node --test"}}\' > package.json',
      'fi',
      'mkdir -p src docs/ai-command-center',
      'echo "// scaffolded by AI Command Center" > src/index.js',
      'echo "# Architecture" > docs/ai-command-center/architecture.md'
    );
  } else {
    lines.push(
      'cat > docs/ai-command-center/execution-log.md <<\'EOF\'',
      `# Execution`,
      '',
      goal,
      '',
      `- at: $(date -u +%Y-%m-%dT%H:%M:%SZ)`,
      'EOF'
    );
    lines.push(
      'mkdir -p src',
      `cat > "src/feature-$(date +%s).js" <<'EOF'`,
      '// Auto-generated feature stub for local shell agent MVP',
      `export const goal = ${JSON.stringify(goal)};`,
      'export function run() { return { ok: true, goal }; }',
      'EOF'
    );
  }

  lines.push('echo "[ai-command-center] shell agent done"');
  return `${lines.join('\n')}\n`;
}

function shellEscape(value: string): string {
  return value.replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 500);
}

export { createRun, updateRun, appendLog };
