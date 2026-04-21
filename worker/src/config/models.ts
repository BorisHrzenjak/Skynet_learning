export const MODELS = {
  generator: 'anthropic/claude-sonnet-4.6',
  examiner: 'anthropic/claude-sonnet-4.6',
  helper: 'z-ai/glm-5.1',
  recall: 'z-ai/glm-5.1',
} as const

export const DEFAULT_UNLOCK_THRESHOLDS = {
  intermediate: 0.8,
  advanced: 0.85,
} as const
