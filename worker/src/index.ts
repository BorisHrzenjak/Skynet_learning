import { DEFAULT_UNLOCK_THRESHOLDS, MODELS } from './config/models'
import { PYODIDE_PACKAGES } from './config/pyodidePackages'
import {
  estimateUsageCost,
  getCurrentSpend,
  isWithinCostCaps,
  recordSpend,
} from './lib/cost'
import { HARDCODED_EXERCISES } from './lib/hardcodedExercises'
import { createChatCompletion } from './lib/openrouter'
import { calculateAttemptScore } from './lib/scoring'
import { GENERATOR_SYSTEM_PROMPT } from './prompts/generator'
import { EXAMINER_SYSTEM_PROMPT } from './prompts/examiner'
import { HELPER_SYSTEM_PROMPT } from './prompts/helper'
import { RECALL_SYSTEM_PROMPT } from './prompts/recall'

type DifficultyBand = 'basic' | 'intermediate' | 'advanced'

type Env = {
  DB: D1Database
  API_SHARED_TOKEN: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  OPENROUTER_HTTP_REFERER?: string
  OPENROUTER_APP_TITLE?: string
}

type TopicRow = {
  topic_id: string
  display_name: string
  difficulty_band: DifficultyBand
  score: number | null
  attempt_count: number | null
  last_updated: number | null
}

type AttemptRow = {
  id: string
  exercise_id: string
  passed: number
  per_attempt_score: number
  created_at: number
  difficulty_band: DifficultyBand | null
}

type AttemptSummaryRow = {
  total_attempts: number | null
  total_time_spent_seconds: number | null
}

type SettingsRow = {
  cost_cap_daily_usd: number | null
  cost_cap_monthly_usd: number | null
  models_json: string
  preferred_topics_json: string | null
  unlock_thresholds_json: string
}

type ScoreRow = {
  per_attempt_score: number
}

type StoredExerciseRow = {
  id: string
  prompt_md: string
  starter_code: string | null
  reference_solution: string
  tests: string
  difficulty_band: DifficultyBand
}

type ExerciseTopicLinkRow = {
  id: string
  display_name: string
}

type PromptRow = {
  prompt_md: string
}

type ExerciseTopicSummary = {
  id: string
  displayName: string
}

type ExerciseRecord = {
  id: string
  promptMd: string
  starterCode: string | null
  referenceSolution: string
  tests: string
  difficultyBand: DifficultyBand
  topics: ExerciseTopicSummary[]
}

type EffectiveSettings = {
  costCapDailyUsd: number | null
  costCapMonthlyUsd: number | null
  modelOverrides: Record<string, string>
  models: Record<string, string>
  preferredTopics: string[]
  unlockThresholds: Record<string, number>
}

type DifficultyMixEntry = {
  band: DifficultyBand
  weight: number
}

type ExerciseSubmissionRequest = {
  exerciseId: string
  submittedCode: string
  passed: boolean
  runCount: number
  recallUsedCount: number
  chatUsedCount: number
  timeSpentSeconds: number
  abandoned?: boolean
  testResults?: Array<{
    name: string
    status: 'passed' | 'failed'
    message: string
  }>
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type ChatRequest = {
  exerciseId?: string
  code: string
  history: ChatMessage[]
  message: string
}

type RecallRequest = {
  code: string
  hint: string
  lineContext?: string
}

type SettingsUpdateRequest = {
  costCapDailyUsd: number | null
  costCapMonthlyUsd: number | null
  modelOverrides: Record<string, string>
  preferredTopics: string[]
  unlockThresholds: Record<string, number>
}

type GeneratedExerciseCandidate = {
  id: string
  promptMd: string
  starterCode: string | null
  referenceSolution: string
  tests: string
  difficultyBand: DifficultyBand
  topics: ExerciseTopicSummary[]
}

type NextExerciseRequest =
  | {
      verification?: undefined
    }
  | {
      verification: {
        candidateId: string
        passed: boolean
      }
    }

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-app-token',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
} as const

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  })
}

function parseJson<T>(value: string | null, fallback: T) {
  if (!value) {
    return fallback
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function averageScore(rows: TopicRow[], band: DifficultyBand) {
  const eligible = rows.filter(
    (row) => row.difficulty_band === band && (row.attempt_count ?? 0) >= 3,
  )

  if (!eligible.length) {
    return null
  }

  const total = eligible.reduce((sum, row) => sum + (row.score ?? 0), 0)
  return total / eligible.length
}

function getCurrentDifficultyBand(
  rows: TopicRow[],
  unlockThresholds: Record<string, number>,
): DifficultyBand {
  const basicAverage = averageScore(rows, 'basic')
  const intermediateAverage = averageScore(rows, 'intermediate')

  if (
    intermediateAverage !== null &&
    intermediateAverage >= (unlockThresholds.advanced ?? DEFAULT_UNLOCK_THRESHOLDS.advanced)
  ) {
    return 'advanced'
  }

  if (
    basicAverage !== null &&
    basicAverage >= (unlockThresholds.intermediate ?? DEFAULT_UNLOCK_THRESHOLDS.intermediate)
  ) {
    return 'intermediate'
  }

  return 'basic'
}

function getDifficultyMix(currentBand: DifficultyBand): DifficultyMixEntry[] {
  if (currentBand === 'advanced') {
    return [
      { band: 'advanced', weight: 0.5 },
      { band: 'intermediate', weight: 0.35 },
      { band: 'basic', weight: 0.15 },
    ]
  }

  if (currentBand === 'intermediate') {
    return [
      { band: 'intermediate', weight: 0.7 },
      { band: 'basic', weight: 0.3 },
    ]
  }

  return [{ band: 'basic', weight: 1 }]
}

function pickWeightedBand(currentBand: DifficultyBand) {
  const mix = getDifficultyMix(currentBand)
  const roll = Math.random()
  let cursor = 0

  for (const entry of mix) {
    cursor += entry.weight
    if (roll <= cursor) {
      return entry.band
    }
  }

  return mix[mix.length - 1]?.band ?? 'basic'
}

function pickWeightedTopic(rows: TopicRow[]) {
  if (!rows.length) {
    return null
  }

  const weighted = rows.map((row) => {
    const score = row.score ?? 0
    const attemptCount = row.attempt_count ?? 0
    const weaknessWeight = Math.max(0.1, 1.15 - score)
    const noveltyBoost = attemptCount < 3 ? 0.2 : 0
    return {
      row,
      weight: weaknessWeight + noveltyBoost,
    }
  })

  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0)
  let roll = Math.random() * totalWeight

  for (const entry of weighted) {
    roll -= entry.weight
    if (roll <= 0) {
      return entry.row
    }
  }

  return weighted[weighted.length - 1]?.row ?? null
}

function withAuth(request: Request, env: Env) {
  const token = request.headers.get('x-app-token')
  return token !== null && token === env.API_SHARED_TOKEN
}

async function hashExercise(candidate: {
  promptMd: string
  starterCode: string | null
  referenceSolution: string
  tests: string
}) {
  const text = JSON.stringify(candidate)
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function stripCodeFences(value: string) {
  const trimmed = value.trim()

  if (!trimmed.startsWith('```')) {
    return trimmed
  }

  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function summarizePrompt(promptMd: string) {
  return promptMd
    .replace(/[#>*`|_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function validateGeneratedExercisePayload(payload: {
  prompt_md: string
  starter_code: string
  reference_solution: string
  tests: string
}) {
  const required = [payload.prompt_md, payload.starter_code, payload.reference_solution, payload.tests]

  if (required.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('Generated exercise payload is missing required fields.')
  }

  if (!/from\s+solution\s+import/m.test(payload.tests)) {
    throw new Error('Generated tests must import from solution.')
  }

  if (!/def\s+test_/m.test(payload.tests)) {
    throw new Error('Generated tests must define at least one test_ function.')
  }

  if (/\bpytest\b/.test(payload.tests)) {
    throw new Error('Generated tests must not depend on pytest.')
  }

  const forbidden = /(subprocess|os\.system|requests|urllib|socket|tkinter)/
  if (forbidden.test(payload.reference_solution) || forbidden.test(payload.tests)) {
    throw new Error('Generated exercise used forbidden libraries or APIs.')
  }
}

function toPublicExercise(exercise: ExerciseRecord) {
  return {
    id: exercise.id,
    promptMd: exercise.promptMd,
    starterCode: exercise.starterCode,
    tests: exercise.tests,
    difficultyBand: exercise.difficultyBand,
    topics: exercise.topics,
  }
}

async function ensureHardcodedExercises(env: Env) {
  const createdAt = Date.now()
  const statements: D1PreparedStatement[] = []

  for (const exercise of HARDCODED_EXERCISES) {
    statements.push(
      env.DB.prepare(
        `
          INSERT OR IGNORE INTO exercises (
            id,
            prompt_md,
            starter_code,
            reference_solution,
            tests,
            difficulty_band,
            hash,
            created_at,
            parent_exercise_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `,
      ).bind(
        exercise.id,
        exercise.promptMd,
        exercise.starterCode,
        exercise.referenceSolution,
        exercise.tests,
        exercise.difficultyBand,
        `hardcoded:${exercise.id}`,
        createdAt,
      ),
    )

    for (const topic of exercise.topics) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO exercise_topics (exercise_id, topic_id) VALUES (?, ?)`,
        ).bind(exercise.id, topic.id),
      )
    }
  }

  await env.DB.batch(statements)
}

async function getEffectiveSettings(env: Env): Promise<EffectiveSettings> {
  const settingsRow = await env.DB.prepare(
    `
      SELECT
        cost_cap_daily_usd,
        cost_cap_monthly_usd,
        models_json,
        preferred_topics_json,
        unlock_thresholds_json
      FROM settings
      WHERE id = 1
    `,
  ).first<SettingsRow>()

  const modelOverrides = parseJson<Record<string, string>>(settingsRow?.models_json ?? '{}', {})
  const unlockThresholds = parseJson<Record<string, number>>(
    settingsRow?.unlock_thresholds_json ?? null,
    { ...DEFAULT_UNLOCK_THRESHOLDS },
  )

  return {
    costCapDailyUsd: settingsRow?.cost_cap_daily_usd ?? null,
    costCapMonthlyUsd: settingsRow?.cost_cap_monthly_usd ?? null,
    modelOverrides,
    models: {
      ...MODELS,
      ...modelOverrides,
    },
    preferredTopics: parseJson<string[]>(settingsRow?.preferred_topics_json ?? null, []),
    unlockThresholds,
  }
}

async function getExerciseRecord(env: Env, exerciseId: string) {
  const row = await env.DB.prepare(
    `
      SELECT id, prompt_md, starter_code, reference_solution, tests, difficulty_band
      FROM exercises
      WHERE id = ?
    `,
  ).bind(exerciseId).first<StoredExerciseRow>()

  if (!row) {
    return null
  }

  const topicResults = await env.DB.prepare(
    `
      SELECT topics.id, topics.display_name
      FROM exercise_topics
      INNER JOIN topics ON topics.id = exercise_topics.topic_id
      WHERE exercise_topics.exercise_id = ?
      ORDER BY topics.display_name
    `,
  ).bind(exerciseId).all<ExerciseTopicLinkRow>()

  return {
    id: row.id,
    promptMd: row.prompt_md,
    starterCode: row.starter_code,
    referenceSolution: row.reference_solution,
    tests: row.tests,
    difficultyBand: row.difficulty_band,
    topics: (topicResults.results ?? []).map((topic) => ({
      id: topic.id,
      displayName: topic.display_name,
    })),
  } satisfies ExerciseRecord
}

async function getStatePayload(env: Env) {
  const effectiveSettings = await getEffectiveSettings(env)
  const currentSpend = await getCurrentSpend(env)

  const topicResults = await env.DB.prepare(
    `
      SELECT
        topics.id AS topic_id,
        topics.display_name,
        topics.difficulty_band,
        competence.score,
        competence.attempt_count,
        competence.last_updated
      FROM topics
      LEFT JOIN competence ON competence.topic_id = topics.id
      ORDER BY
        CASE topics.difficulty_band
          WHEN 'basic' THEN 1
          WHEN 'intermediate' THEN 2
          ELSE 3
        END,
        topics.display_name
    `,
  ).all<TopicRow>()

  const recentAttemptResults = await env.DB.prepare(
    `
      SELECT
        attempts.id,
        attempts.exercise_id,
        attempts.passed,
        attempts.per_attempt_score,
        attempts.created_at,
        exercises.difficulty_band
      FROM attempts
      LEFT JOIN exercises ON exercises.id = attempts.exercise_id
      ORDER BY attempts.created_at DESC
      LIMIT 10
    `,
  ).all<AttemptRow>()

  const attemptSummary = await env.DB.prepare(
    `
      SELECT
        COUNT(*) AS total_attempts,
        COALESCE(SUM(time_spent_seconds), 0) AS total_time_spent_seconds
      FROM attempts
    `,
  ).first<AttemptSummaryRow>()

  const competenceMap = (topicResults.results ?? []).map((row) => ({
    topicId: row.topic_id,
    displayName: row.display_name,
    difficultyBand: row.difficulty_band,
    score: row.score ?? 0,
    attemptCount: row.attempt_count ?? 0,
    lastUpdated: row.last_updated,
  }))

  return {
    competenceMap,
    recentHistory: (recentAttemptResults.results ?? []).map((row) => ({
      id: row.id,
      exerciseId: row.exercise_id,
      passed: row.passed === 1,
      perAttemptScore: row.per_attempt_score,
      createdAt: row.created_at,
      difficultyBand: row.difficulty_band,
    })),
    settings: effectiveSettings,
    spend: {
      dailyUsd: currentSpend.dailyUsd,
      monthlyUsd: currentSpend.monthlyUsd,
    },
    prompts: {
      generator: GENERATOR_SYSTEM_PROMPT,
      examiner: EXAMINER_SYSTEM_PROMPT,
      helper: HELPER_SYSTEM_PROMPT,
      recall: RECALL_SYSTEM_PROMPT,
    },
    summary: {
      totalAttempts: attemptSummary?.total_attempts ?? 0,
      totalTimeSpentSeconds: attemptSummary?.total_time_spent_seconds ?? 0,
    },
    currentDifficultyBand: getCurrentDifficultyBand(
      topicResults.results ?? [],
      effectiveSettings.unlockThresholds,
    ),
  }
}

async function handleState(env: Env) {
  return json(await getStatePayload(env))
}

async function runModelCall(options: {
  env: Env
  settings: EffectiveSettings
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  maxTokens?: number
}) {
  if (!options.env.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter is not configured on the worker.')
  }

  const spend = await getCurrentSpend(options.env)

  if (
    !isWithinCostCaps({
      costCapDailyUsd: options.settings.costCapDailyUsd,
      costCapMonthlyUsd: options.settings.costCapMonthlyUsd,
      dailyUsd: spend.dailyUsd,
      monthlyUsd: spend.monthlyUsd,
    })
  ) {
    throw new Error('The configured LLM cost cap has been reached.')
  }

  const result = await createChatCompletion({
    apiKey: options.env.OPENROUTER_API_KEY,
    model: options.model,
    baseUrl: options.env.OPENROUTER_BASE_URL,
    referer: options.env.OPENROUTER_HTTP_REFERER,
    title: options.env.OPENROUTER_APP_TITLE ?? 'Skynet learning',
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    messages: options.messages,
  })

  await recordSpend(options.env, spend.day, estimateUsageCost(options.model, result.usage))
  return result.content
}

async function chooseTargetTopic(env: Env, settings: EffectiveSettings, difficultyBand: DifficultyBand) {
  const recentExerciseResults = await env.DB.prepare(
    `
      SELECT DISTINCT exercise_id
      FROM attempts
      ORDER BY created_at DESC
      LIMIT 2
    `,
  ).all<{ exercise_id: string }>()

  const recentExerciseIds = (recentExerciseResults.results ?? []).map((row) => row.exercise_id)
  const recentTopicIds = new Set<string>()

  if (recentExerciseIds.length > 0) {
    const placeholders = recentExerciseIds.map(() => '?').join(', ')
    const recentTopicResults = await env.DB.prepare(
      `
        SELECT DISTINCT topic_id
        FROM exercise_topics
        WHERE exercise_id IN (${placeholders})
      `,
    ).bind(...recentExerciseIds).all<{ topic_id: string }>()

    for (const row of recentTopicResults.results ?? []) {
      recentTopicIds.add(row.topic_id)
    }
  }

  const topicResults = await env.DB.prepare(
    `
      SELECT
        topics.id AS topic_id,
        topics.display_name,
        topics.difficulty_band,
        competence.score,
        competence.attempt_count,
        competence.last_updated
      FROM topics
      LEFT JOIN competence ON competence.topic_id = topics.id
      WHERE topics.difficulty_band = ?
      ORDER BY COALESCE(competence.score, 0) ASC, COALESCE(competence.attempt_count, 0) ASC
    `,
  ).bind(difficultyBand).all<TopicRow>()

  const allowed = (topicResults.results ?? []).filter((topic) => {
    return (
      (!settings.preferredTopics.length || settings.preferredTopics.includes(topic.topic_id)) &&
      !recentTopicIds.has(topic.topic_id)
    )
  })

  const fallback = (topicResults.results ?? []).filter((topic) => {
    return !settings.preferredTopics.length || settings.preferredTopics.includes(topic.topic_id)
  })

  const topic =
    pickWeightedTopic(allowed) ??
    pickWeightedTopic(fallback) ??
    pickWeightedTopic(topicResults.results ?? [])

  if (!topic) {
    return null
  }

  return {
    id: topic.topic_id,
    displayName: topic.display_name,
    difficultyBand: topic.difficulty_band,
  }
}

async function getCachedExercise(
  env: Env,
  topicId: string,
  difficultyBand: DifficultyBand,
) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const row = await env.DB.prepare(
    `
      SELECT exercises.id
      FROM exercises
      INNER JOIN exercise_topics ON exercise_topics.exercise_id = exercises.id
      WHERE exercise_topics.topic_id = ?
        AND exercises.difficulty_band = ?
        AND exercises.hash NOT LIKE 'pending:%'
        AND NOT EXISTS (
          SELECT 1
          FROM attempts
          WHERE attempts.exercise_id = exercises.id
            AND attempts.created_at >= ?
        )
      ORDER BY
        CASE
          WHEN exercises.hash LIKE 'mbpp:%' THEN 0
          WHEN exercises.hash LIKE 'hardcoded:%' THEN 2
          ELSE 1
        END,
        RANDOM()
      LIMIT 1
    `,
  ).bind(topicId, difficultyBand, cutoff).first<{ id: string }>()

  if (!row) {
    return null
  }

  return getExerciseRecord(env, row.id)
}

async function getImportedFallbackExercise(env: Env) {
  const row = await env.DB.prepare(
    `
      SELECT exercises.id
      FROM exercises
      WHERE exercises.hash LIKE 'mbpp:%'
      ORDER BY (
        SELECT COUNT(*)
        FROM attempts
        WHERE attempts.exercise_id = exercises.id
      ) ASC, RANDOM()
      LIMIT 1
    `,
  ).first<{ id: string }>()

  if (!row) {
    return null
  }

  return getExerciseRecord(env, row.id)
}

async function getRecentExerciseSummaries(env: Env) {
  const recentPromptResults = await env.DB.prepare(
    `
      SELECT prompt_md
      FROM exercises
      ORDER BY created_at DESC
      LIMIT 5
    `,
  ).all<PromptRow>()

  return (recentPromptResults.results ?? []).map((row) => summarizePrompt(row.prompt_md))
}

async function getHardcodedFallbackExercise(env: Env) {
  const row = await env.DB.prepare(
    `
      SELECT exercises.id
      FROM exercises
      WHERE exercises.hash LIKE 'hardcoded:%'
      ORDER BY (
        SELECT COUNT(*)
        FROM attempts
        WHERE attempts.exercise_id = exercises.id
      ) ASC, RANDOM()
      LIMIT 1
    `,
  ).first<{ id: string }>()

  if (!row) {
    return null
  }

  return getExerciseRecord(env, row.id)
}

function buildGeneratorUserMessage(
  topic: ExerciseTopicSummary,
  difficultyBand: DifficultyBand,
  recentSummaries: string[],
) {
  return [
    `Target topic: ${topic.displayName} (${topic.id})`,
    `Target difficulty band: ${difficultyBand}`,
    '',
    'Constraints:',
    '- Stdlib only',
    '- No network I/O',
    '- No subprocess usage',
    '- No real OS file access',
    '- Keep the exercise self-contained and short',
    '- Tests must import from solution',
    '- Tests must use plain Python test_ functions and assert statements',
    '- Make the prompt easy to scan for a learner',
    '- Explicitly explain what goes in, what should come out, and any tricky rules',
    '- Use markdown sections and include an example when it helps',
    '- Do not leave key requirements implied; spell them out clearly',
    '- If a common mistake is likely, add one short note that calls it out directly',
    `- Additional available packages: ${PYODIDE_PACKAGES.length ? PYODIDE_PACKAGES.join(', ') : 'none (stdlib only)'}`,
    '',
    'Avoid repeating these recent exercise shapes:',
    ...recentSummaries.map((summary, index) => `${index + 1}. ${summary}`),
    '',
    'Return JSON only.',
  ].join('\n')
}

async function generateExerciseCandidate(
  env: Env,
  settings: EffectiveSettings,
  topic: ExerciseTopicSummary,
  difficultyBand: DifficultyBand,
) {
  const recentSummaries = await getRecentExerciseSummaries(env)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const content = await runModelCall({
      env,
      settings,
      model: settings.models.generator ?? MODELS.generator,
      temperature: 0.5,
      maxTokens: 900,
      messages: [
        { role: 'system', content: GENERATOR_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildGeneratorUserMessage(topic, difficultyBand, recentSummaries),
        },
      ],
    })

    const payload = JSON.parse(stripCodeFences(content)) as {
      prompt_md: string
      starter_code: string
      reference_solution: string
      tests: string
    }

    validateGeneratedExercisePayload(payload)

    return {
      id: crypto.randomUUID(),
      promptMd: payload.prompt_md,
      starterCode: payload.starter_code ?? '',
      referenceSolution: payload.reference_solution,
      tests: payload.tests,
      difficultyBand,
      topics: [topic],
    } satisfies GeneratedExerciseCandidate
  }

  throw new Error('Generator did not produce a valid exercise after retries.')
}

async function persistPendingExercise(env: Env, candidate: GeneratedExerciseCandidate) {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `
        INSERT OR REPLACE INTO exercises (
          id,
          prompt_md,
          starter_code,
          reference_solution,
          tests,
          difficulty_band,
          hash,
          created_at,
          parent_exercise_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
    ).bind(
      candidate.id,
      candidate.promptMd,
      candidate.starterCode,
      candidate.referenceSolution,
      candidate.tests,
      candidate.difficultyBand,
      `pending:${candidate.id}`,
      Date.now(),
    ),
  ]

  for (const topic of candidate.topics) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO exercise_topics (exercise_id, topic_id) VALUES (?, ?)`,
      ).bind(candidate.id, topic.id),
    )
  }

  await env.DB.batch(statements)
}

async function finalizePendingExercise(env: Env, candidateId: string) {
  const record = await getExerciseRecord(env, candidateId)

  if (!record) {
    throw new Error('Generated exercise candidate was not found.')
  }

  const hash = await hashExercise(record)
  const existing = await env.DB.prepare(
    `SELECT id FROM exercises WHERE hash = ? AND id != ?`,
  ).bind(hash, candidateId).first<{ id: string }>()

  if (existing?.id) {
    await env.DB.prepare(`DELETE FROM exercise_topics WHERE exercise_id = ?`).bind(candidateId).run()
    await env.DB.prepare(`DELETE FROM exercises WHERE id = ?`).bind(candidateId).run()
    const existingRecord = await getExerciseRecord(env, existing.id)

    if (!existingRecord) {
      throw new Error('Failed to load existing verified exercise.')
    }

    return existingRecord
  }

  await env.DB.prepare(`UPDATE exercises SET hash = ? WHERE id = ?`).bind(hash, candidateId).run()
  const finalized = await getExerciseRecord(env, candidateId)

  if (!finalized) {
    throw new Error('Failed to load finalized exercise.')
  }

  return finalized
}

async function handleNextExercise(request: Request, env: Env) {
  await ensureHardcodedExercises(env)

  const payload = (await request.json().catch(() => ({}))) as NextExerciseRequest

  if (payload.verification) {
    if (!payload.verification.passed) {
      await env.DB.prepare(`DELETE FROM exercise_topics WHERE exercise_id = ?`)
        .bind(payload.verification.candidateId)
        .run()
      await env.DB.prepare(`DELETE FROM exercises WHERE id = ?`)
        .bind(payload.verification.candidateId)
        .run()
      return json({ error: 'Generated exercise failed browser verification.' }, 400)
    }

    const exercise = await finalizePendingExercise(env, payload.verification.candidateId)
    return json({ mode: 'ready', exercise: toPublicExercise(exercise) })
  }

  const settings = await getEffectiveSettings(env)
  const state = await getStatePayload(env)
  const difficultyBand = pickWeightedBand(state.currentDifficultyBand)
  const topic = await chooseTargetTopic(env, settings, difficultyBand)
  const importedFallback = await getImportedFallbackExercise(env)
  const hardcodedFallback = await getHardcodedFallbackExercise(env)

  if (!topic) {
    if (importedFallback) {
      return json({ mode: 'ready', exercise: toPublicExercise(importedFallback) })
    }

    if (hardcodedFallback) {
      return json({ mode: 'ready', exercise: toPublicExercise(hardcodedFallback) })
    }

    return json({ error: 'No topic is available for the next exercise.' }, 500)
  }

  const shouldServeCache = Math.random() < 0.7 || !env.OPENROUTER_API_KEY
  const cachedExercise = await getCachedExercise(env, topic.id, difficultyBand)

  if (cachedExercise && shouldServeCache) {
    return json({ mode: 'ready', exercise: toPublicExercise(cachedExercise) })
  }

  if (env.OPENROUTER_API_KEY) {
    try {
      const candidate = await generateExerciseCandidate(env, settings, topic, difficultyBand)

      if (candidate) {
        await persistPendingExercise(env, candidate)
        return json({ mode: 'verify', candidate })
      }
    } catch {
      if (cachedExercise) {
        return json({ mode: 'ready', exercise: toPublicExercise(cachedExercise) })
      }
    }
  }

  if (cachedExercise) {
    return json({ mode: 'ready', exercise: toPublicExercise(cachedExercise) })
  }

  if (importedFallback) {
    return json({ mode: 'ready', exercise: toPublicExercise(importedFallback) })
  }

  if (hardcodedFallback) {
    return json({ mode: 'ready', exercise: toPublicExercise(hardcodedFallback) })
  }

  return json({ error: 'Could not prepare a verified exercise. Try again.' }, 500)
}

async function recomputeCompetence(env: Env, topicIds: string[]) {
  const now = Date.now()

  for (const topicId of topicIds) {
    const scoreResults = await env.DB.prepare(
      `
        SELECT attempts.per_attempt_score
        FROM attempts
        INNER JOIN exercise_topics ON exercise_topics.exercise_id = attempts.exercise_id
        WHERE exercise_topics.topic_id = ?
        ORDER BY attempts.created_at DESC
      `,
    ).bind(topicId).all<ScoreRow>()

    const scores = (scoreResults.results ?? []).map((row) => row.per_attempt_score)
    const recentScores = scores.slice(0, 10)
    const average = recentScores.length
      ? recentScores.reduce((sum, score) => sum + score, 0) / recentScores.length
      : 0

    await env.DB.prepare(
      `
        INSERT INTO competence (topic_id, score, attempt_count, last_updated)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(topic_id) DO UPDATE SET
          score = excluded.score,
          attempt_count = excluded.attempt_count,
          last_updated = excluded.last_updated
      `,
    ).bind(topicId, average, scores.length, now).run()
  }
}

function buildSubmissionReview(
  payload: ExerciseSubmissionRequest,
  perAttemptScore: number,
) {
  if (payload.abandoned) {
    return `Result: skipped\n\nThis exercise was skipped. Recorded score: ${perAttemptScore.toFixed(2)}.`
  }

  if (payload.passed) {
    return `Result: pass\n\nTests passed locally. Recorded score: ${perAttemptScore.toFixed(2)}.`
  }

  const failedTests = (payload.testResults ?? []).filter((test) => test.status === 'failed')
  return `Result: fail\n\n${failedTests.length || 1} test failure(s) were reported. Recorded score: ${perAttemptScore.toFixed(2)}.`
}

function buildExaminerUserMessage(options: {
  promptMd: string
  submittedCode: string
  passed: boolean
  perAttemptScore: number
  runCount: number
  recallUsedCount: number
  chatUsedCount: number
  timeSpentSeconds: number
  abandoned?: boolean
  testResults: Array<{
    name: string
    status: 'passed' | 'failed'
    message: string
  }>
}) {
  return [
    'Exercise prompt:',
    options.promptMd,
    '',
    'User code:',
    '```python',
    options.submittedCode,
    '```',
    '',
    'Result from tests only:',
    options.abandoned ? 'skipped' : options.passed ? 'pass' : 'fail',
    '',
    'Interaction signals:',
    JSON.stringify(
      {
        perAttemptScore: options.perAttemptScore,
        runCount: options.runCount,
        recallUsedCount: options.recallUsedCount,
        chatUsedCount: options.chatUsedCount,
        timeSpentSeconds: options.timeSpentSeconds,
        abandoned: options.abandoned ?? false,
      },
      null,
      2,
    ),
    '',
    'Test results:',
    JSON.stringify(options.testResults, null, 2),
  ].join('\n')
}

async function getExaminerReview(options: {
  env: Env
  model: string
  promptMd: string
  payload: ExerciseSubmissionRequest
  perAttemptScore: number
}) {
  if (options.payload.abandoned || !options.env.OPENROUTER_API_KEY) {
    return buildSubmissionReview(options.payload, options.perAttemptScore)
  }

  try {
    return await runModelCall({
      env: options.env,
      settings: await getEffectiveSettings(options.env),
      model: options.model,
      messages: [
        {
          role: 'system',
          content: EXAMINER_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: buildExaminerUserMessage({
            promptMd: options.promptMd,
            submittedCode: options.payload.submittedCode,
            passed: options.payload.passed,
            perAttemptScore: options.perAttemptScore,
            runCount: options.payload.runCount,
            recallUsedCount: options.payload.recallUsedCount,
            chatUsedCount: options.payload.chatUsedCount,
            timeSpentSeconds: options.payload.timeSpentSeconds,
            abandoned: options.payload.abandoned,
            testResults: options.payload.testResults ?? [],
          }),
        },
      ],
    })
  } catch {
    return buildSubmissionReview(options.payload, options.perAttemptScore)
  }
}

function buildHelperUserMessage(options: {
  promptMd: string
  code: string
  message: string
}) {
  return [
    'Current exercise:',
    options.promptMd,
    '',
    'Current code:',
    '```python',
    options.code,
    '```',
    '',
    'User message:',
    options.message,
  ].join('\n')
}

function buildFallbackHelperMessage(options: {
  promptMd: string
  code: string
  message: string
}) {
  const normalized = options.message.toLowerCase()
  const plainPrompt = options.promptMd
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`|_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (
    /(explain this task|i don't understand|plain language|what is this asking|explain the task)/.test(
      normalized,
    )
  ) {
    return [
      'Plain-language version:',
      '',
      plainPrompt,
      '',
      'Focus on three things:',
      '- what goes into the function',
      '- what should come back out',
      '- any special rules or edge cases in the prompt',
    ].join('\n')
  }

  if (/(what's going wrong|what is going wrong|explain what's going wrong|tests failed|error)/.test(normalized)) {
    return [
      'I could not get a model explanation right now.',
      '',
      'A good next step is to compare your function output with the first failing test case.',
      'Check the exact input, the exact expected result, and where your current code behaves differently.',
      '',
      'If you want, ask again with the first failing test and I will help break it down.',
    ].join('\n')
  }

  return [
    'I could not get a model response right now.',
    '',
    'Try asking for one specific thing:',
    '- explain the task in plain language',
    '- explain the first failing test',
    '- hint at the next step without giving the full solution',
  ].join('\n')
}

function buildRecallUserMessage(options: RecallRequest) {
  return [
    `Hint: ${options.hint}`,
    '',
    'Current line or context:',
    options.lineContext || '(not provided)',
    '',
    'Current code:',
    '```python',
    options.code,
    '```',
  ].join('\n')
}

function buildFallbackRecallMessage(hint: string) {
  const normalized = hint.toLowerCase()

  if (/(count|increment|dictionary|dict)/.test(normalized)) {
    return [
      '```python',
      'counts[word] = counts.get(word, 0) + 1',
      '```',
      'Use this when you want to increment a dictionary counter in one line.',
      '',
      '```python',
      'if word in counts:',
      '    counts[word] += 1',
      'else:',
      '    counts[word] = 1',
      '```',
      'Use this when you want the explicit branch form.',
    ].join('\n')
  }

  if (/(append|list|add item)/.test(normalized)) {
    return [
      '```python',
      'result.append(value)',
      '```',
      'Use this to add one item to the end of a list.',
      '',
      '```python',
      'result.extend(values)',
      '```',
      'Use this when you already have an iterable of multiple items.',
    ].join('\n')
  }

  if (/(loop|index|enumerate)/.test(normalized)) {
    return [
      '```python',
      'for item in items:',
      '    ...',
      '```',
      'Use this for a plain loop over values.',
      '',
      '```python',
      'for index, item in enumerate(items):',
      '    ...',
      '```',
      'Use this when you need both the index and the value.',
    ].join('\n')
  }

  if (/(read|file|lines)/.test(normalized)) {
    return [
      '```python',
      'with open(path) as file:',
      '    text = file.read()',
      '```',
      'Use this when you want the whole file as one string.',
      '',
      '```python',
      'with open(path) as file:',
      '    lines = file.readlines()',
      '```',
      'Use this when you want a list of lines.',
    ].join('\n')
  }

  return [
    '```python',
    '# sketch the syntax you need here',
    '```',
    'Use this as a placeholder and adapt it to your current line.',
  ].join('\n')
}

async function handleChat(request: Request, env: Env) {
  const payload = (await request.json()) as ChatRequest

  const effectiveSettings = await getEffectiveSettings(env)
  const exercise = payload.exerciseId ? await getExerciseRecord(env, payload.exerciseId) : null

  if (!exercise) {
    return json({ error: 'Unknown exercise id for helper chat.' }, 400)
  }

  if (!env.OPENROUTER_API_KEY) {
    return json({
      message: buildFallbackHelperMessage({
        promptMd: exercise.promptMd,
        code: payload.code,
        message: payload.message,
      }),
    })
  }

  const message = await runModelCall({
    env,
    settings: effectiveSettings,
    model: effectiveSettings.models.helper ?? MODELS.helper,
    temperature: 0.4,
    maxTokens: 260,
    messages: [
      { role: 'system', content: HELPER_SYSTEM_PROMPT },
      ...payload.history.map((entry) => ({
        role: entry.role,
        content: entry.content,
      })),
      {
        role: 'user',
        content: buildHelperUserMessage({
          promptMd: exercise.promptMd,
          code: payload.code,
          message: payload.message,
        }),
      },
    ],
  }).catch((error) => {
    if (error instanceof Error && /cost cap/i.test(error.message)) {
      return error.message
    }

    return buildFallbackHelperMessage({
      promptMd: exercise.promptMd,
      code: payload.code,
      message: payload.message,
    })
  })

  return json({ message })
}

async function handleRecall(request: Request, env: Env) {
  const payload = (await request.json()) as RecallRequest

  const effectiveSettings = await getEffectiveSettings(env)

  if (!env.OPENROUTER_API_KEY) {
    return json({
      message: buildFallbackRecallMessage(payload.hint),
    })
  }

  const message = await runModelCall({
    env,
    settings: effectiveSettings,
    model: effectiveSettings.models.recall ?? MODELS.recall,
    temperature: 0.3,
    maxTokens: 240,
    messages: [
      { role: 'system', content: RECALL_SYSTEM_PROMPT },
      { role: 'user', content: buildRecallUserMessage(payload) },
    ],
  }).catch(() => buildFallbackRecallMessage(payload.hint))

  return json({ message })
}

async function handleSettings(request: Request, env: Env) {
  const payload = (await request.json()) as SettingsUpdateRequest

  const costCapDailyUsd =
    typeof payload.costCapDailyUsd === 'number' ? payload.costCapDailyUsd : null
  const costCapMonthlyUsd =
    typeof payload.costCapMonthlyUsd === 'number' ? payload.costCapMonthlyUsd : null
  const modelOverrides = payload.modelOverrides ?? {}
  const preferredTopics = Array.isArray(payload.preferredTopics) ? payload.preferredTopics : []
  const unlockThresholds = payload.unlockThresholds ?? { ...DEFAULT_UNLOCK_THRESHOLDS }

  await env.DB.prepare(
    `
      UPDATE settings
      SET
        cost_cap_daily_usd = ?,
        cost_cap_monthly_usd = ?,
        models_json = ?,
        preferred_topics_json = ?,
        unlock_thresholds_json = ?
      WHERE id = 1
    `,
  ).bind(
    costCapDailyUsd,
    costCapMonthlyUsd,
    JSON.stringify(modelOverrides),
    preferredTopics.length ? JSON.stringify(preferredTopics) : null,
    JSON.stringify(unlockThresholds),
  ).run()

  return json(await getStatePayload(env))
}

async function handleSubmit(request: Request, env: Env) {
  await ensureHardcodedExercises(env)

  const payload = (await request.json()) as ExerciseSubmissionRequest
  const exercise = await getExerciseRecord(env, payload.exerciseId)
  const effectiveSettings = await getEffectiveSettings(env)

  if (!exercise) {
    return json({ error: 'Unknown exercise id.' }, 400)
  }

  const runCount = Math.max(0, Math.floor(payload.runCount || 0))
  const recallUsedCount = Math.max(0, Math.floor(payload.recallUsedCount || 0))
  const chatUsedCount = Math.max(0, Math.floor(payload.chatUsedCount || 0))
  const timeSpentSeconds = Math.max(0, Math.floor(payload.timeSpentSeconds || 0))
  const perAttemptScore = calculateAttemptScore({
    passed: payload.passed,
    runCount,
    recallUsedCount,
    chatUsedCount,
    abandoned: payload.abandoned,
  })
  const attemptId = crypto.randomUUID()
  const examinerReviewMd = await getExaminerReview({
    env,
    model: effectiveSettings.models.examiner ?? MODELS.examiner,
    promptMd: exercise.promptMd,
    payload,
    perAttemptScore,
  })

  await env.DB.prepare(
    `
      INSERT INTO attempts (
        id,
        exercise_id,
        submitted_code,
        passed,
        per_attempt_score,
        run_count,
        recall_used_count,
        chat_used_count,
        time_spent_seconds,
        examiner_review_md,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).bind(
    attemptId,
    payload.exerciseId,
    payload.submittedCode,
    payload.passed ? 1 : 0,
    perAttemptScore,
    runCount,
    recallUsedCount,
    chatUsedCount,
    timeSpentSeconds,
    examinerReviewMd,
    Date.now(),
  ).run()

  await recomputeCompetence(
    env,
    exercise.topics.map((topic) => topic.id),
  )

  return json({
    attemptId,
    passed: payload.passed,
    perAttemptScore,
    examinerReviewMd,
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      })
    }

    if (url.pathname.startsWith('/api/') && !withAuth(request, env)) {
      return json({ error: 'Unauthorized' }, 401)
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return handleState(env)
    }

    if (request.method === 'POST' && url.pathname === '/api/exercise/next') {
      return handleNextExercise(request, env)
    }

    if (request.method === 'POST' && url.pathname === '/api/exercise/submit') {
      return handleSubmit(request, env)
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChat(request, env)
    }

    if (request.method === 'POST' && url.pathname === '/api/recall') {
      return handleRecall(request, env)
    }

    if (request.method === 'POST' && url.pathname === '/api/settings') {
      return handleSettings(request, env)
    }

    return json({ error: 'Not found' }, 404)
  },
} satisfies ExportedHandler<Env>
