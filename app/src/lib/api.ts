export type DifficultyBand = 'basic' | 'intermediate' | 'advanced'

export type ExerciseTopic = {
  id: string
  displayName: string
}

export type Exercise = {
  id: string
  promptMd: string
  starterCode: string | null
  tests: string
  difficultyBand: DifficultyBand
  topics: ExerciseTopic[]
}

export type ExerciseTestResult = {
  name: string
  status: 'passed' | 'failed'
  message: string
}

export type ExerciseSubmission = {
  exerciseId: string
  submittedCode: string
  passed: boolean
  runCount: number
  recallUsedCount: number
  chatUsedCount: number
  timeSpentSeconds: number
  abandoned?: boolean
  testResults: ExerciseTestResult[]
}

export type ExerciseSubmissionResult = {
  attemptId: string
  passed: boolean
  perAttemptScore: number
  examinerReviewMd: string | null
}

export type CompetenceTopic = {
  topicId: string
  displayName: string
  difficultyBand: DifficultyBand
  score: number
  attemptCount: number
  lastUpdated: number | null
}

export type AppSettings = {
  costCapDailyUsd: number | null
  costCapMonthlyUsd: number | null
  modelOverrides: Record<string, string>
  models: Record<string, string>
  preferredTopics: string[]
  unlockThresholds: Record<string, number>
}

export type RecentAttempt = {
  id: string
  exerciseId: string
  passed: boolean
  perAttemptScore: number
  createdAt: number
  difficultyBand: DifficultyBand | null
}

export type AppState = {
  competenceMap: CompetenceTopic[]
  recentHistory: RecentAttempt[]
  settings: AppSettings
  currentDifficultyBand: DifficultyBand
}

async function apiFetch<T>(path: string, init?: RequestInit) {
  const config = getApiConfig()

  if (!config) {
    throw new Error('Set VITE_API_BASE_URL and VITE_API_TOKEN to load backend state.')
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-app-token': config.token,
      ...init?.headers,
    },
  })

  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}.`)
  }

  return (await response.json()) as T
}

export function getApiConfig() {
  const baseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
  const token = import.meta.env.VITE_API_TOKEN?.trim()

  if (!baseUrl || !token) {
    return null
  }

  return { baseUrl, token }
}

export async function fetchAppState() {
  return apiFetch<AppState>('/api/state', {
    method: 'GET',
  })
}

export async function fetchNextExercise() {
  return apiFetch<{ exercise: Exercise }>('/api/exercise/next', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export async function submitExercise(payload: ExerciseSubmission) {
  return apiFetch<ExerciseSubmissionResult>('/api/exercise/submit', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
