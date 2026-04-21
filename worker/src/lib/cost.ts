const MODEL_RATES_PER_MILLION = {
  'anthropic/claude-sonnet-4.6': {
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
  },
  'z-ai/glm-5.1': {
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 1.2,
  },
} as const

export type TokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

type CostEnv = {
  DB: D1Database
}

type SpendRow = {
  estimated_usd: number | null
}

export function estimateUsageCost(model: string, usage: TokenUsage | null) {
  if (!usage) {
    return 0
  }

  const rates = MODEL_RATES_PER_MILLION[model as keyof typeof MODEL_RATES_PER_MILLION]

  if (!rates) {
    return 0
  }

  const inputCost = (usage.promptTokens / 1_000_000) * rates.inputUsdPerMillion
  const outputCost = (usage.completionTokens / 1_000_000) * rates.outputUsdPerMillion
  return inputCost + outputCost
}

export async function getCurrentSpend(env: CostEnv) {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const monthPrefix = day.slice(0, 7)

  const dailyRow = await env.DB.prepare(
    `SELECT estimated_usd FROM llm_spend WHERE date = ?`,
  ).bind(day).first<SpendRow>()

  const monthlyRows = await env.DB.prepare(
    `SELECT estimated_usd FROM llm_spend WHERE date LIKE ?`,
  ).bind(`${monthPrefix}%`).all<SpendRow>()

  return {
    day,
    dailyUsd: dailyRow?.estimated_usd ?? 0,
    monthlyUsd: (monthlyRows.results ?? []).reduce(
      (sum, row) => sum + (row.estimated_usd ?? 0),
      0,
    ),
  }
}

export async function recordSpend(env: CostEnv, date: string, usd: number) {
  if (usd <= 0) {
    return
  }

  await env.DB.prepare(
    `
      INSERT INTO llm_spend (date, estimated_usd)
      VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET
        estimated_usd = estimated_usd + excluded.estimated_usd
    `,
  ).bind(date, usd).run()
}

export function isWithinCostCaps(options: {
  costCapDailyUsd: number | null
  costCapMonthlyUsd: number | null
  dailyUsd: number
  monthlyUsd: number
}) {
  if (
    options.costCapDailyUsd !== null &&
    options.costCapDailyUsd !== undefined &&
    options.dailyUsd >= options.costCapDailyUsd
  ) {
    return false
  }

  if (
    options.costCapMonthlyUsd !== null &&
    options.costCapMonthlyUsd !== undefined &&
    options.monthlyUsd >= options.costCapMonthlyUsd
  ) {
    return false
  }

  return true
}
