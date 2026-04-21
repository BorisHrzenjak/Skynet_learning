export type OpenRouterMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
}

type OpenRouterContent = string | Array<{ type?: string; text?: string }> | undefined

function readContent(content: OpenRouterContent) {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  }

  return ''
}

export async function createChatCompletion(options: {
  apiKey: string
  model: string
  messages: OpenRouterMessage[]
  baseUrl?: string
  referer?: string
  title?: string
  temperature?: number
  maxTokens?: number
}) {
  const response = await fetch(
    `${options.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        ...(options.referer ? { 'http-referer': options.referer } : {}),
        ...(options.title ? { 'x-title': options.title } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 220,
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`OpenRouter request failed with ${response.status}.`)
  }

  const payload = (await response.json()) as OpenRouterResponse
  const content = readContent(payload.choices?.[0]?.message?.content)

  if (!content.trim()) {
    throw new Error('OpenRouter returned an empty examiner response.')
  }

  return content.trim()
}
