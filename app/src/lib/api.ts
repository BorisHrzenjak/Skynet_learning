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

export type ExerciseCandidate = Exercise & {
  referenceSolution: string
}

export type NextExerciseResponse =
  | {
      mode: 'ready'
      exercise: Exercise
    }
  | {
      mode: 'verify'
      candidate: ExerciseCandidate
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

export type ChatRole = 'user' | 'assistant'

export type ChatEntry = {
  role: ChatRole
  content: string
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
  spend: {
    dailyUsd: number
    monthlyUsd: number
  }
  prompts: {
    generator: string
    examiner: string
    helper: string
    recall: string
  }
  summary: {
    totalAttempts: number
    totalTimeSpentSeconds: number
  }
  currentDifficultyBand: DifficultyBand
}

export type SettingsUpdate = {
  costCapDailyUsd: number | null
  costCapMonthlyUsd: number | null
  modelOverrides: Record<string, string>
  preferredTopics: string[]
  unlockThresholds: Record<string, number>
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
    let errorMessage = `${path} failed with ${response.status}.`

    try {
      const payload = (await response.json()) as { error?: string }
      if (typeof payload.error === 'string' && payload.error.trim()) {
        errorMessage = payload.error
      }
    } catch {
      // Keep the fallback status-based message.
    }

    throw new Error(errorMessage)
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
  return apiFetch<NextExerciseResponse>('/api/exercise/next', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export async function confirmVerifiedExercise(candidate: ExerciseCandidate) {
  return apiFetch<{ mode: 'ready'; exercise: Exercise }>('/api/exercise/next', {
    method: 'POST',
    body: JSON.stringify({
      verification: {
        candidateId: candidate.id,
        passed: true,
      },
    }),
  })
}

export async function submitExercise(payload: ExerciseSubmission) {
  return apiFetch<ExerciseSubmissionResult>('/api/exercise/submit', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function sendChatMessage(payload: {
  exerciseId: string
  code: string
  history: ChatEntry[]
  message: string
}) {
  return apiFetch<{ message: string }>('/api/chat', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function requestRecall(payload: {
  code: string
  hint: string
  lineContext?: string
}) {
  return apiFetch<{ message: string }>('/api/recall', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function saveSettings(payload: SettingsUpdate) {
  return apiFetch<AppState>('/api/settings', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
