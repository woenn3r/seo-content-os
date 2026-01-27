export type UsageRecord = {
  scope: "generation" | "research" | "retrieval" | "revision";
  page_id?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  created_at: string;
};

export type UsageSummary = {
  run_id: string;
  totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
  };
  records: UsageRecord[];
};

const MODEL_COSTS: Record<
  string,
  { input_per_1k: number; output_per_1k: number }
> = {
  "gpt-4.1": { input_per_1k: 0.01, output_per_1k: 0.03 },
  "gpt-4.1-mini": { input_per_1k: 0.003, output_per_1k: 0.006 },
  "gpt-4.1-nano": { input_per_1k: 0.0005, output_per_1k: 0.0015 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_COSTS[model] || MODEL_COSTS["gpt-4.1-mini"];
  const cost =
    (inputTokens / 1000) * pricing.input_per_1k +
    (outputTokens / 1000) * pricing.output_per_1k;
  return Number(cost.toFixed(6));
}

export function buildUsageSummary(runId: string, records: UsageRecord[]): UsageSummary {
  const totals = records.reduce(
    (acc, record) => {
      acc.input_tokens += record.input_tokens;
      acc.output_tokens += record.output_tokens;
      acc.total_tokens += record.total_tokens;
      acc.cost_usd += record.cost_usd;
      return acc;
    },
    { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
  );

  return {
    run_id: runId,
    totals: {
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      total_tokens: totals.total_tokens,
      cost_usd: Number(totals.cost_usd.toFixed(6)),
    },
    records,
  };
}
