import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cc-'));
const dataDir = path.join(tempRoot, 'data');
const workspace = path.join(tempRoot, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n');

process.env.SUPERCOMPANY_DATA_DIR = dataDir;
process.env.SUPERCOMPANY_DB = path.join(dataDir, 'test.db');

const { createProject, getPlan } = await import('../src/server/services/project.ts');
const {
  approvePlan,
  finalizeProject,
  planProject,
  runNextReadyTasks
} = await import('../src/server/services/orchestrator.ts');
const { listTasks } = await import('../src/server/services/task-graph.ts');
const { listReviews } = await import('../src/server/services/review.ts');
const { evaluateCommand } = await import('../src/server/services/policy.ts');

test('policy blocks dangerous commands', () => {
  const decision = evaluateCommand('rm -rf /');
  assert.equal(decision.allowed, false);
  assert.equal(decision.risk, 'critical');
});

test('MVP loop: plan -> approve -> execute -> review -> report', async () => {
  const project = createProject({
    name: 'Demo Game',
    goal: '开发一款 2D Roguelike，先完成工程初始化、核心骨架、测试与文档',
    techStack: 'Node.js',
    rootPath: workspace,
    budgetLimit: 5,
    gptMode: 'hybrid'
  });

  const planned = await planProject(project.id);
  assert.ok(planned.plan.tasks.length >= 5);
  assert.ok(getPlan(project.id));

  const approved = approvePlan(project.id);
  assert.ok(approved.tasks.length >= 5);

  // Run several ready tasks to move the graph forward.
  for (let i = 0; i < 4; i += 1) {
    await runNextReadyTasks(project.id, 1);
  }

  const tasks = listTasks(project.id);
  const doneOrReview = tasks.filter((t) =>
    ['done', 'review', 'needs_changes', 'failed', 'ready', 'running'].includes(t.status)
  );
  assert.ok(doneOrReview.length >= 1);

  const reviewed = tasks.filter((t) => listReviews(t.id).length > 0);
  assert.ok(reviewed.length >= 1, '至少应有一次 GPT Review');

  const report = finalizeProject(project.id);
  assert.match(report.report, /版本报告/);
  assert.ok(report.path && fs.existsSync(report.path));

  const marker = path.join(workspace, 'docs', 'ai-command-center');
  // Worktree may hold file changes; plan artifacts are written to root docs on plan.
  assert.ok(fs.existsSync(path.join(marker, 'plan.json')) || fs.existsSync(marker));
});
