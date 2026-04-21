import { DEFAULT_UNLOCK_THRESHOLDS, MODELS } from './config/models'
import { HARDCODED_EXERCISES } from './lib/hardcodedExercises'
import { createChatCompletion } from './lib/openrouter'
import { calculateAttemptScore } from './lib/scoring'
import { EXAMINER_SYSTEM_PROMPT } from './prompts/examiner'

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

type SettingsRow = {
  cost_cap_daily_usd: number | null
  cost_cap_monthly_usd: number | null
  models_json: string
  preferred_topics_json: string | null
  unlock_thresholds_json: string
}

type ExerciseAttemptCountRow = {
  exercise_id: string
  attempt_count: number
}

type ScoreRow = {
  per_attempt_score: number
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

type EffectiveSettings = {
  costCapDailyUsd: number | null
  costCapMonthlyUsd: number | null
  modelOverrides: Record<string, string>
  models: Record<string, string>
  preferredTopics: string[]
  unlockThresholds: Record<string, number>
}

const HARDCODED_EXERCISE_MAP = new Map(
  HARDCODED_EXERCISES.map((exercise) => [exercise.id, exercise]),
)

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

function withAuth(request: Request, env: Env) {
  const token = request.headers.get('x-app-token')
  return token !== null && token === env.API_SHARED_TOKEN
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

async function getStatePayload(env: Env) {
  const effectiveSettings = await getEffectiveSettings(env)

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
    currentDifficultyBand: getCurrentDifficultyBand(
      topicResults.results ?? [],
      effectiveSettings.unlockThresholds,
    ),
  }
}

async function handleState(env: Env) {
  return json(await getStatePayload(env))
}

async function handleNextExercise(env: Env) {
  await ensureHardcodedExercises(env)

  const recentAttemptResults = await env.DB.prepare(
    `
      SELECT exercise_id
      FROM attempts
      ORDER BY created_at DESC
      LIMIT 2
    `,
  ).all<{ exercise_id: string }>()

  const attemptCountResults = await env.DB.prepare(
    `
      SELECT exercise_id, COUNT(*) AS attempt_count
      FROM attempts
      GROUP BY exercise_id
    `,
  ).all<ExerciseAttemptCountRow>()

  const recentExerciseIds = new Set(
    (recentAttemptResults.results ?? []).map((row) => row.exercise_id),
  )
  const attemptCounts = new Map(
    (attemptCountResults.results ?? []).map((row) => [row.exercise_id, row.attempt_count]),
  )

  const sortedExercises = [...HARDCODED_EXERCISES].sort((left, right) => {
    return (attemptCounts.get(left.id) ?? 0) - (attemptCounts.get(right.id) ?? 0)
  })

  const exercise =
    sortedExercises.find((candidate) => !recentExerciseIds.has(candidate.id)) ??
    sortedExercises[0]

  return json({
    exercise: {
      id: exercise.id,
      promptMd: exercise.promptMd,
      starterCode: exercise.starterCode,
      tests: exercise.tests,
      difficultyBand: exercise.difficultyBand,
      topics: exercise.topics,
    },
  })
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
    return await createChatCompletion({
      apiKey: options.env.OPENROUTER_API_KEY,
      model: options.model,
      baseUrl: options.env.OPENROUTER_BASE_URL,
      referer: options.env.OPENROUTER_HTTP_REFERER,
      title: options.env.OPENROUTER_APP_TITLE ?? 'Python Learning App',
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

async function handleSubmit(request: Request, env: Env) {
  await ensureHardcodedExercises(env)

  const payload = (await request.json()) as ExerciseSubmissionRequest
  const exercise = HARDCODED_EXERCISE_MAP.get(payload.exerciseId)
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

function notImplemented(pathname: string) {
  return json(
    {
      error: `${pathname} is not implemented yet.`,
    },
    501,
  )
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
      return handleNextExercise(env)
    }

    if (request.method === 'POST' && url.pathname === '/api/exercise/submit') {
      return handleSubmit(request, env)
    }

    if (
      ['POST', 'GET'].includes(request.method) &&
      ['/api/chat', '/api/recall', '/api/settings'].includes(url.pathname)
    ) {
      return notImplemented(url.pathname)
    }

    return json({ error: 'Not found' }, 404)
  },
} satisfies ExportedHandler<Env>
