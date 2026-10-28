export type TaskStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'review'
  | 'needs_changes'
  | 'done'
  | 'failed';

export type ReviewStatus = 'passed' | 'conditional' | 'needs_changes';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type EventType =
  | 'project_created'
  | 'plan_created'
  | 'plan_approved'
  | 'task_started'
  | 'progress_updated'
  | 'command_started'
  | 'command_finished'
  | 'file_changed'
  | 'artifact_created'
  | 'test_passed'
  | 'test_failed'
  | 'approval_required'
  | 'approval_resolved'
  | 'task_completed'
  | 'task_failed'
  | 'review_completed'
  | 'cost_recorded';

export interface Project {
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
  plan_json: string | null;
  plan_status: 'none' | 'draft' | 'approved';
  gpt_mode: 'api' | 'chatgpt_assist' | 'hybrid';
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  priority: number;
  assigned_agent: string | null;
  dependencies: string;
  acceptance_criteria: string;
  allowed_paths: string;
  allowed_commands: string;
  input_files: string;
  output_files: string;
  budget_limit: number;
  timeout_ms: number;
  retry_count: number;
  max_retries: number;
  result_summary: string;
  created_at: string;
  completed_at: string | null;
}

export interface Run {
  id: string;
  task_id: string;
  agent_id: string;
  worktree_path: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  cost: number;
  status: string;
  log: string;
  diff: string;
  test_output: string;
}

export interface Artifact {
  id: string;
  project_id: string;
  task_id: string | null;
  type: string;
  path: string;
  hash: string | null;
  version: number;
  created_at: string;
}

export interface Review {
  id: string;
  task_id: string;
  reviewer: string;
  status: ReviewStatus;
  score: number;
  findings: string;
  repair_tasks: string;
  summary: string;
  created_at: string;
}

export interface Approval {
  id: string;
  project_id: string;
  task_id: string | null;
  action: string;
  risk_level: RiskLevel;
  description: string;
  status: ApprovalStatus;
  approved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface TimelineEvent {
  id: string;
  project_id: string;
  task_id: string | null;
  type: EventType;
  message: string;
  payload: string;
  created_at: string;
}

export interface CostRecord {
  id: string;
  project_id: string;
  task_id: string | null;
  agent: string;
  model: string;
  tokens: number;
  cost: number;
  duration_ms: number;
  status: string;
  created_at: string;
}

export interface AgentCapability {
  id: string;
  name: string;
  kind: 'shell' | 'http' | 'gpt' | 'manual';
  task_types: string[];
  can_read_files: boolean;
  can_write_files: boolean;
  can_run_commands: boolean;
  supports_streaming: boolean;
  supports_structured: boolean;
  estimated_cost: number;
  location: 'local' | 'remote';
  description: string;
}

export interface PlanOutput {
  summary: string;
  userStories: string[];
  architecture: string;
  risks: string[];
  acceptanceCriteria: string[];
  recommendedAgents: string[];
  tasks: Array<{
    title: string;
    goal: string;
    priority?: number;
    assignedAgent?: string;
    dependencies?: string[];
    acceptanceCriteria?: string[];
    allowedPaths?: string[];
    allowedCommands?: string[];
  }>;
}

export interface ReviewOutput {
  status: ReviewStatus;
  score: number;
  findings: Array<{
    severity: 'low' | 'medium' | 'high';
    file?: string;
    description: string;
  }>;
  repairTasks: string[];
  summary: string;
  riskLevel: RiskLevel;
}

export interface AgentTaskRequest {
  taskId: string;
  projectId: string;
  title: string;
  goal: string;
  contextRefs: string[];
  allowedPaths: string[];
  allowedCommands: string[];
  acceptanceCriteria: string[];
  rootPath: string;
  worktreePath?: string;
  budget: { maxTokens: number; maxCost: number };
}

export interface AgentTaskResult {
  status: 'completed' | 'failed' | 'needs_approval';
  summary: string;
  log: string;
  diff: string;
  testOutput: string;
  exitCode: number;
  cost: number;
  artifacts: string[];
  approvalAction?: string;
  approvalRisk?: RiskLevel;
  approvalDescription?: string;
}
