export const RISK_LEVELS = ["read", "write", "destructive", "privileged"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const RANK: Record<RiskLevel, number> = { read: 0, write: 1, destructive: 2, privileged: 3 };

export function riskRank(risk: RiskLevel): number {
  return RANK[risk];
}

export function maxRisk(risks: Iterable<RiskLevel>): RiskLevel {
  let best: RiskLevel = "read";
  for (const r of risks) if (RANK[r] > RANK[best]) best = r;
  return best;
}

export const EXECUTION_TARGETS = ["server", "device"] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];

export const TRUST_LEVELS = ["system", "user", "internal", "external"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
