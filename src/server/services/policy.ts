import type { RiskLevel } from '../types.ts';

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\b/i,
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bsudo\b/i
];

const HIGH_RISK_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+publish\b/i,
  /\bdocker\s+push\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\b/i,
  /\bsendmail\b/i,
  /\bmail\b/i
];

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  risk: RiskLevel;
  reason: string;
  action: string;
}

export function evaluateCommand(command: string, whitelist: string[] = []): PolicyDecision {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      allowed: false,
      requiresApproval: false,
      risk: 'low',
      reason: '空命令',
      action: 'shell.empty'
    };
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        requiresApproval: false,
        risk: 'critical',
        reason: `危险命令已拦截: ${trimmed}`,
        action: 'shell.dangerous'
      };
    }
  }

  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: true,
        requiresApproval: true,
        risk: 'high',
        reason: `高风险命令需要审批: ${trimmed}`,
        action: 'shell.high_risk'
      };
    }
  }

  if (whitelist.length > 0) {
    const ok = whitelist.some((item) => trimmed === item || trimmed.startsWith(`${item} `));
    if (!ok) {
      return {
        allowed: true,
        requiresApproval: true,
        risk: 'medium',
        reason: `命令不在白名单，需要审批: ${trimmed}`,
        action: 'shell.unlisted'
      };
    }
  }

  return {
    allowed: true,
    requiresApproval: false,
    risk: 'low',
    reason: '允许执行',
    action: 'shell.run'
  };
}

export function evaluateFileDelete(filePath: string): PolicyDecision {
  return {
    allowed: true,
    requiresApproval: true,
    risk: 'high',
    reason: `删除文件需要审批: ${filePath}`,
    action: 'fs.delete'
  };
}

export function evaluateBudget(spent: number, limit: number, nextCost: number): PolicyDecision {
  if (spent + nextCost > limit) {
    return {
      allowed: true,
      requiresApproval: true,
      risk: 'high',
      reason: `预计费用将超过预算 (已用 ${spent.toFixed(4)} / 限额 ${limit})`,
      action: 'budget.over'
    };
  }
  return {
    allowed: true,
    requiresApproval: false,
    risk: 'low',
    reason: '预算充足',
    action: 'budget.ok'
  };
}
