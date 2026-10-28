export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data as T;
}

export type Project = {
  id: string;
  name: string;
  description: string;
  goal: string;
  project_type: string;
  tech_stack: string;
  root_path: string;
  repository_url: string;
  budget_limit: number;
  spent: number;
  stage: string;
  plan_status: string;
  gpt_mode: string;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  status: string;
  priority: number;
  assigned_agent: string | null;
  dependencyIds: string[];
  acceptance: string[];
  result_summary: string;
};

export type TimelineEvent = {
  id: string;
  project_id: string;
  task_id: string | null;
  type: string;
  message: string;
  payload: string;
  created_at: string;
};

export type Approval = {
  id: string;
  project_id: string;
  task_id: string | null;
  action: string;
  risk_level: string;
  description: string;
  status: string;
  created_at: string;
};

export type Plan = {
  summary: string;
  userStories: string[];
  architecture: string;
  risks: string[];
  acceptanceCriteria: string[];
  recommendedAgents: string[];
  tasks: Array<{ title: string; goal: string; assignedAgent?: string }>;
};
