import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  api,
  Approval,
  Plan,
  Project,
  Task,
  TimelineEvent
} from './api';

type ProjectDetail = {
  project: Project;
  plan: Plan | null;
  tasks: Task[];
  graph: { nodes: Array<{ id: string; title: string; status: string; agent: string | null }>; edges: Array<{ from: string; to: string }> };
  events: TimelineEvent[];
  approvals: Approval[];
  costs: { spent: number; limit: number; byAgent: Record<string, number> };
};

type TaskDetail = {
  task: Task;
  latestRun: {
    log: string;
    diff: string;
    test_output: string;
    status: string;
    exit_code: number | null;
  } | null;
  reviews: Array<{ status: string; score: number; summary: string; findings: string; repair_tasks: string }>;
};

const emptyForm = {
  name: '',
  goal: '',
  description: '',
  techStack: 'Node.js / TypeScript',
  rootPath: '',
  budgetLimit: 10,
  gptMode: 'hybrid'
};

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [importText, setImportText] = useState('');
  const [assistPrompt, setAssistPrompt] = useState('');
  const [bottomTab, setBottomTab] = useState<'log' | 'diff' | 'test' | 'review'>('log');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('gpt-4o-mini');

  const selected = detail?.project;

  async function refreshProjects(preferId?: string | null) {
    const data = await api<{ projects: Project[] }>('/api/projects');
    setProjects(data.projects);
    const nextId = preferId ?? selectedId ?? data.projects[0]?.id ?? null;
    setSelectedId(nextId);
    if (nextId) await loadProject(nextId);
  }

  async function loadProject(id: string) {
    const data = await api<ProjectDetail>(`/api/projects/${id}`);
    setDetail(data);
    if (taskId && !data.tasks.some((t) => t.id === taskId)) {
      setTaskId(null);
      setTaskDetail(null);
    } else if (taskId) {
      await loadTask(taskId);
    }
  }

  async function loadTask(id: string) {
    const data = await api<TaskDetail>(`/api/tasks/${id}`);
    setTaskDetail(data);
    setTaskId(id);
  }

  useEffect(() => {
    refreshProjects().catch((err) => setError(err.message));
    api<{ settings: { openaiBaseUrl: string; openaiModel: string } }>('/api/bootstrap')
      .then((data) => {
        setBaseUrl(data.settings.openaiBaseUrl);
        setModel(data.settings.openaiModel);
      })
      .catch(() => undefined);

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    ws.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data);
        if (payload.type === 'event' && selectedId && payload.event.project_id === selectedId) {
          loadProject(selectedId).catch(() => undefined);
        }
      } catch {
        // ignore
      }
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    loadProject(selectedId).catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const budgetPct = useMemo(() => {
    if (!detail) return 0;
    if (!detail.costs.limit) return 0;
    return Math.min(100, (detail.costs.spent / detail.costs.limit) * 100);
  }, [detail]);

  async function withBusy(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    await withBusy('创建项目', async () => {
      const project = await api<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(form)
      });
      setForm(emptyForm);
      await refreshProjects(project.id);
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1 className="brand">
            AI <span>指挥台</span>
          </h1>
          <p>GPT 负责思考、指挥和验收；本地 Agent 负责执行；你负责关键决策。</p>
        </div>
        <div className="row">
          {busy ? <span className="meta">进行中：{busy}</span> : null}
          <button className="btn secondary" type="button" onClick={() => setSettingsOpen((v) => !v)}>
            设置
          </button>
        </div>
      </header>

      <aside className="panel left">
        <div className="panel-head">
          <h2>项目空间</h2>
        </div>
        <div className="panel-body stack">
          <form className="stack" onSubmit={onCreate}>
            <div className="field">
              <label>项目名称</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：Roguelike MVP"
                required
              />
            </div>
            <div className="field">
              <label>项目目标</label>
              <textarea
                value={form.goal}
                onChange={(e) => setForm({ ...form, goal: e.target.value })}
                placeholder="用自然语言描述你要交付什么"
              />
            </div>
            <div className="field">
              <label>本地代码目录</label>
              <input
                value={form.rootPath}
                onChange={(e) => setForm({ ...form, rootPath: e.target.value })}
                placeholder="/absolute/path/to/repo"
              />
            </div>
            <div className="field">
              <label>技术栈</label>
              <input
                value={form.techStack}
                onChange={(e) => setForm({ ...form, techStack: e.target.value })}
              />
            </div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label>预算 ($)</label>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={form.budgetLimit}
                  onChange={(e) => setForm({ ...form, budgetLimit: Number(e.target.value) })}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>GPT 模式</label>
                <select
                  value={form.gptMode}
                  onChange={(e) => setForm({ ...form, gptMode: e.target.value })}
                >
                  <option value="hybrid">混合</option>
                  <option value="api">API</option>
                  <option value="chatgpt_assist">ChatGPT 辅助</option>
                </select>
              </div>
            </div>
            <button className="btn" type="submit">
              创建项目
            </button>
          </form>

          <div className="project-list">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`project-item ${selectedId === project.id ? 'active' : ''}`}
                onClick={() => setSelectedId(project.id)}
              >
                <strong>{project.name}</strong>
                <div className="meta">
                  {project.stage} · {project.plan_status}
                </div>
                <div className="budget-bar">
                  <span
                    style={{
                      width: `${Math.min(100, (project.spent / Math.max(project.budget_limit, 0.0001)) * 100)}%`
                    }}
                  />
                </div>
              </button>
            ))}
            {!projects.length ? <div className="empty">还没有项目</div> : null}
          </div>
        </div>
      </aside>

      <main className="panel center">
        <div className="panel-head">
          <h2>{selected ? selected.name : '任务编排'}</h2>
          {selected ? (
            <div className="row">
              <button
                className="btn secondary"
                type="button"
                disabled={!!busy}
                onClick={() =>
                  withBusy('生成计划', async () => {
                    const result = await api<{ plan: Plan; source: string; assist?: { prompt: string } }>(
                      `/api/projects/${selected.id}/plan`,
                      { method: 'POST', body: '{}' }
                    );
                    if (result.assist?.prompt) setAssistPrompt(result.assist.prompt);
                    await loadProject(selected.id);
                  })
                }
              >
                GPT 规划
              </button>
              <button
                className="btn"
                type="button"
                disabled={!!busy || selected.plan_status !== 'draft'}
                onClick={() =>
                  withBusy('批准计划', async () => {
                    await api(`/api/projects/${selected.id}/approve-plan`, {
                      method: 'POST',
                      body: '{}'
                    });
                    await loadProject(selected.id);
                  })
                }
              >
                批准执行
              </button>
              <button
                className="btn warn"
                type="button"
                disabled={!!busy}
                onClick={() =>
                  withBusy('执行下一任务', async () => {
                    await api(`/api/projects/${selected.id}/run-next`, {
                      method: 'POST',
                      body: JSON.stringify({ limit: 1 })
                    });
                    await loadProject(selected.id);
                  })
                }
              >
                执行下一任务
              </button>
              <button
                className="btn secondary"
                type="button"
                disabled={!!busy}
                onClick={() =>
                  withBusy('生成报告', async () => {
                    await api(`/api/projects/${selected.id}/finalize`, {
                      method: 'POST',
                      body: '{}'
                    });
                    await loadProject(selected.id);
                  })
                }
              >
                版本报告
              </button>
            </div>
          ) : null}
        </div>
        <div className="panel-body stack">
          {error ? <div className="error">{error}</div> : null}
          {!selected ? (
            <div className="empty">创建并选择一个项目，开始规划与执行</div>
          ) : (
            <>
              <div className="row">
                <span className="status">{selected.stage}</span>
                <span className="meta">目录：{selected.root_path || '未绑定'}</span>
                <span className="meta">
                  预算 ${detail?.costs.spent.toFixed(4)} / ${detail?.costs.limit}
                </span>
              </div>
              <div className="budget-bar">
                <span style={{ width: `${budgetPct}%` }} />
              </div>

              {detail?.plan ? (
                <div className="stack">
                  <strong>计划摘要</strong>
                  <div className="meta">{detail.plan.summary}</div>
                  <div className="plan-box">{detail.plan.architecture}</div>
                </div>
              ) : (
                <div className="empty">尚未生成计划。点击「GPT 规划」。</div>
              )}

              <div>
                <div className="panel-head" style={{ padding: '0 0 10px', border: 0 }}>
                  <h2>任务图</h2>
                  <span className="meta">{detail?.tasks.length || 0} 个任务</span>
                </div>
                <div className="graph">
                  {detail?.tasks.map((task) => (
                    <div
                      key={task.id}
                      className={`task-card ${taskId === task.id ? 'active' : ''}`}
                      onClick={() => loadTask(task.id)}
                    >
                      <strong>{task.title}</strong>
                      <div className="row">
                        <span className={`status ${task.status}`}>{task.status}</span>
                        <span className="meta">{task.assigned_agent || 'unassigned'}</span>
                      </div>
                      <div className="meta" style={{ marginTop: 8 }}>
                        {task.goal.slice(0, 80)}
                      </div>
                    </div>
                  ))}
                  {!detail?.tasks.length ? <div className="empty">批准计划后生成任务</div> : null}
                </div>
              </div>

              {taskDetail ? (
                <div className="stack">
                  <div className="row">
                    <strong>{taskDetail.task.title}</strong>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        withBusy('执行任务', async () => {
                          await api(`/api/tasks/${taskDetail.task.id}/run`, {
                            method: 'POST',
                            body: '{}'
                          });
                          await loadProject(selected.id);
                          await loadTask(taskDetail.task.id);
                        })
                      }
                    >
                      执行此任务
                    </button>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        withBusy('GPT Review', async () => {
                          await api(`/api/tasks/${taskDetail.task.id}/review`, {
                            method: 'POST',
                            body: '{}'
                          });
                          await loadProject(selected.id);
                          await loadTask(taskDetail.task.id);
                        })
                      }
                    >
                      GPT Review
                    </button>
                  </div>
                  <div className="meta">{taskDetail.task.goal}</div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </main>

      <aside className="panel right">
        <div className="panel-head">
          <h2>决策与审批</h2>
        </div>
        <div className="panel-body stack">
          {settingsOpen ? (
            <div className="stack">
              <div className="field">
                <label>OpenAI Compatible API Key</label>
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
              </div>
              <div className="field">
                <label>Base URL</label>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="field">
                <label>Model</label>
                <input value={model} onChange={(e) => setModel(e.target.value)} />
              </div>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  withBusy('保存设置', async () => {
                    await api('/api/settings', {
                      method: 'POST',
                      body: JSON.stringify({
                        openaiApiKey: apiKey,
                        openaiBaseUrl: baseUrl,
                        openaiModel: model
                      })
                    });
                    setSettingsOpen(false);
                  })
                }
              >
                保存
              </button>
            </div>
          ) : null}

          {selected ? (
            <>
              <div className="field">
                <label>ChatGPT 辅助规划提示词</label>
                <textarea
                  value={assistPrompt}
                  onChange={(e) => setAssistPrompt(e.target.value)}
                  placeholder="点击下方按钮生成，可复制到 ChatGPT"
                />
              </div>
              <div className="row">
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() =>
                    withBusy('准备提示词', async () => {
                      const data = await api<{ prompt: string }>(
                        `/api/projects/${selected.id}/assist-prompt`
                      );
                      setAssistPrompt(data.prompt);
                    })
                  }
                >
                  生成提示词
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => navigator.clipboard.writeText(assistPrompt)}
                  disabled={!assistPrompt}
                >
                  复制
                </button>
              </div>
              <div className="field">
                <label>导入 ChatGPT JSON 计划</label>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder='粘贴 {"summary":"...","tasks":[...]}'
                />
              </div>
              <button
                className="btn"
                type="button"
                disabled={!importText.trim()}
                onClick={() =>
                  withBusy('导入计划', async () => {
                    const plan = JSON.parse(importText) as Plan;
                    await api(`/api/projects/${selected.id}/import-plan`, {
                      method: 'POST',
                      body: JSON.stringify({ plan })
                    });
                    setImportText('');
                    await loadProject(selected.id);
                  })
                }
              >
                导入计划
              </button>

              <strong>待审批</strong>
              {(detail?.approvals || [])
                .filter((a) => a.status === 'pending')
                .map((approval) => (
                  <div key={approval.id} className="approval-item stack">
                    <div className="meta">
                      {approval.risk_level} · {approval.action}
                    </div>
                    <div>{approval.description}</div>
                    <div className="row">
                      <button
                        className="btn"
                        type="button"
                        onClick={() =>
                          withBusy('批准', async () => {
                            await api(`/api/approvals/${approval.id}/resolve`, {
                              method: 'POST',
                              body: JSON.stringify({ approved: true })
                            });
                            await loadProject(selected.id);
                          })
                        }
                      >
                        批准
                      </button>
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() =>
                          withBusy('拒绝', async () => {
                            await api(`/api/approvals/${approval.id}/resolve`, {
                              method: 'POST',
                              body: JSON.stringify({ approved: false })
                            });
                            await loadProject(selected.id);
                          })
                        }
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                ))}
              {!detail?.approvals?.some((a) => a.status === 'pending') ? (
                <div className="empty">暂无待审批事项</div>
              ) : null}
            </>
          ) : (
            <div className="empty">选择项目后可管理决策</div>
          )}
        </div>
      </aside>

      <section className="panel bottom">
        <div className="panel-head">
          <h2>时间线 / 产物</h2>
          <div className="tabs">
            {(['log', 'diff', 'test', 'review'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`tab ${bottomTab === tab ? 'active' : ''}`}
                onClick={() => setBottomTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
        <div className="panel-body" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12 }}>
          <div className="stack">
            {(detail?.events || []).slice(0, 40).map((event) => (
              <div key={event.id} className="event-item">
                <div className="meta">
                  {new Date(event.created_at).toLocaleString('zh-CN')} · {event.type}
                </div>
                <div>{event.message}</div>
              </div>
            ))}
            {!detail?.events?.length ? <div className="empty">暂无事件</div> : null}
          </div>
          <div>
            {bottomTab === 'log' ? (
              <div className="log-box">{taskDetail?.latestRun?.log || '选择任务查看执行日志'}</div>
            ) : null}
            {bottomTab === 'diff' ? (
              <div className="diff-box">{taskDetail?.latestRun?.diff || '暂无 Diff'}</div>
            ) : null}
            {bottomTab === 'test' ? (
              <div className="log-box">{taskDetail?.latestRun?.test_output || '暂无测试输出'}</div>
            ) : null}
            {bottomTab === 'review' ? (
              <div className="log-box">
                {taskDetail?.reviews?.[0]
                  ? JSON.stringify(
                      {
                        status: taskDetail.reviews[0].status,
                        score: taskDetail.reviews[0].score,
                        summary: taskDetail.reviews[0].summary,
                        findings: safeJson(taskDetail.reviews[0].findings),
                        repairTasks: safeJson(taskDetail.reviews[0].repair_tasks)
                      },
                      null,
                      2
                    )
                  : '暂无 Review'}
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
