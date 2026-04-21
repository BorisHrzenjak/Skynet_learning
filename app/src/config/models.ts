export const MODELS = {
  generator: 'anthropic/claude-sonnet-4.6',
  examiner: 'anthropic/claude-sonnet-4.6',
  helper: 'z-ai/glm-5.1',
  recall: 'z-ai/glm-5.1',
} as const

export type ModelRole = keyof typeof MODELS
