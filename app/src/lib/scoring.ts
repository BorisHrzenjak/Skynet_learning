export type AttemptSignals = {
  passed: boolean
  runCount: number
  recallUsedCount: number
  chatUsedCount: number
  abandoned?: boolean
}

export function calculateAttemptScore(signals: AttemptSignals) {
  if (signals.abandoned || !signals.passed) {
    return 0
  }

  const usedHelp = signals.recallUsedCount > 0 || signals.chatUsedCount > 0

  if (signals.chatUsedCount >= 2) {
    return 0.2
  }

  if (signals.runCount <= 1) {
    return usedHelp ? 0.85 : 1
  }

  if (signals.runCount <= 3) {
    return usedHelp ? 0.55 : 0.7
  }

  return 0.4
}
