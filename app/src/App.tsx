import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { python } from '@codemirror/lang-python'
import { indentOnInput, indentUnit } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import './App.css'
import {
  confirmVerifiedExercise,
  fetchAppState,
  fetchNextExercise,
  getApiConfig,
  requestRecall,
  sendChatMessage,
  submitExercise,
  type AppState,
  type ChatEntry,
  type Exercise,
  type NextExerciseResponse,
} from './lib/api'
import {
  ensureJediLoaded,
  getPyodide,
  getPythonCompletions,
  runPython,
  runPythonWithTests,
  type PythonCompletion,
  type PythonRunResult,
} from './lib/pyodide'

const STARTER_CODE = `def describe_numbers(values):
    for value in values:
        if value % 2 == 0:
            print(f"{value} is even")
        else:
            print(f"{value} is odd")


describe_numbers([1, 2, 3, 4])
`

type RuntimeState = 'loading' | 'ready' | 'error'
type CompletionState = 'loading' | 'ready' | 'error'
type BackendState = 'loading' | 'ready' | 'error' | 'unconfigured'
type ExerciseState = 'loading' | 'ready' | 'error' | 'unconfigured'
type SubmissionState = 'idle' | 'submitting' | 'success' | 'error'
type ChatState = 'idle' | 'sending' | 'error'
type RecallState = 'idle' | 'loading' | 'success' | 'error'

function getCompletionStart(code: string, position: number) {
  let start = position

  while (start > 0 && /[A-Za-z0-9_]/.test(code[start - 1])) {
    start -= 1
  }

  return start
}

function mapCompletionKind(kind: PythonCompletion['kind']): Completion['type'] {
  switch (kind) {
    case 'function':
      return 'function'
    case 'class':
      return 'class'
    case 'module':
      return 'namespace'
    case 'instance':
    case 'param':
    case 'statement':
      return 'variable'
    case 'keyword':
      return 'keyword'
    default:
      return 'text'
  }
}

function pluralize(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function buildRunErrorMessage(run: PythonRunResult) {
  const failedTests = run.tests.filter((test) => test.status === 'failed')

  if (run.stderr.trim()) {
    return `I just ran the code and got this error:\n\n${run.stderr.trim()}\n\nCan you explain what's going wrong?`
  }

  if (failedTests.length > 0) {
    const summary = failedTests
      .slice(0, 2)
      .map((test) => `${test.name}: ${test.message}`)
      .join('\n\n')

    return `I just ran the code and some tests failed:\n\n${summary}\n\nCan you explain what's going wrong?`
  }

  return 'I just ran the code and it failed. Can you explain what to check next?'
}

function formatMessageContent(content: string) {
  return content.replace(/```(?:python)?\n?/g, '').trim()
}

function App() {
  const hasApiConfig = getApiConfig() !== null
  const [code, setCode] = useState(STARTER_CODE)
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('loading')
  const [runtimeError, setRuntimeError] = useState('')
  const [completionState, setCompletionState] = useState<CompletionState>('loading')
  const [completionError, setCompletionError] = useState('')
  const [backendState, setBackendState] = useState<BackendState>(
    hasApiConfig ? 'loading' : 'unconfigured',
  )
  const [backendError, setBackendError] = useState(
    hasApiConfig ? '' : 'Set VITE_API_BASE_URL and VITE_API_TOKEN to fetch worker state.',
  )
  const [appState, setAppState] = useState<AppState | null>(null)
  const [exerciseState, setExerciseState] = useState<ExerciseState>(
    hasApiConfig ? 'loading' : 'unconfigured',
  )
  const [exerciseError, setExerciseError] = useState(
    hasApiConfig ? '' : 'Configure the worker to load exercises.',
  )
  const [currentExercise, setCurrentExercise] = useState<Exercise | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [lastRun, setLastRun] = useState<PythonRunResult | null>(null)
  const [runCount, setRunCount] = useState(0)
  const [exerciseStartedAt, setExerciseStartedAt] = useState<number | null>(null)
  const [submissionState, setSubmissionState] = useState<SubmissionState>('idle')
  const [submissionError, setSubmissionError] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatState, setChatState] = useState<ChatState>('idle')
  const [chatError, setChatError] = useState('')
  const [chatUsedCount, setChatUsedCount] = useState(0)
  const [recallOpen, setRecallOpen] = useState(false)
  const [recallInput, setRecallInput] = useState('')
  const [recallState, setRecallState] = useState<RecallState>('idle')
  const [recallMessage, setRecallMessage] = useState('')
  const [recallUsedCount, setRecallUsedCount] = useState(0)

  const chatInputRef = useRef<HTMLTextAreaElement | null>(null)
  const recallInputRef = useRef<HTMLInputElement | null>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const lastAutoExplainSignatureRef = useRef('')

  const completionSource = useMemo<CompletionSource>(
    () =>
      async (context: CompletionContext) => {
        if (completionState !== 'ready') {
          return null
        }

        const previousCharacter = context.state.sliceDoc(
          Math.max(0, context.pos - 1),
          context.pos,
        )

        if (!context.explicit && !/[A-Za-z0-9_.]/.test(previousCharacter)) {
          return null
        }

        const line = context.state.doc.lineAt(context.pos)
        const completions = await getPythonCompletions(
          context.state.doc.toString(),
          line.number,
          context.pos - line.from,
        ).catch(() => [])

        if (!completions.length) {
          return null
        }

        const from = getCompletionStart(context.state.doc.toString(), context.pos)
        const options: Completion[] = completions.map((completion) => ({
          label: completion.name,
          type: mapCompletionKind(completion.kind),
          detail: completion.detail,
          info: completion.docstring || completion.detail,
        }))

        return { from, options }
      },
    [completionState],
  )

  const editorExtensions = useMemo(
    () => [
      EditorState.tabSize.of(4),
      indentUnit.of('    '),
      indentOnInput(),
      python(),
      autocompletion({ override: [completionSource] }),
    ],
    [completionSource],
  )

  const resetExerciseUi = useCallback((exercise: Exercise) => {
    setCurrentExercise(exercise)
    setCode(exercise.starterCode ?? '')
    setLastRun(null)
    setRunCount(0)
    setExerciseStartedAt(Date.now())
    setSubmissionState('idle')
    setSubmissionError('')
    setChatMessages([])
    setChatInput('')
    setChatState('idle')
    setChatError('')
    setChatUsedCount(0)
    setRecallOpen(false)
    setRecallInput('')
    setRecallState('idle')
    setRecallMessage('')
    setRecallUsedCount(0)
    lastAutoExplainSignatureRef.current = ''
  }, [])

  const refreshAppState = useCallback(async () => {
    if (!hasApiConfig) {
      return
    }

    setBackendState('loading')
    setBackendError('')

    try {
      const state = await fetchAppState()
      setAppState(state)
      setBackendState('ready')
    } catch (error) {
      setBackendState('error')
      setBackendError(
        error instanceof Error ? error.message : 'Failed to load backend state.',
      )
    }
  }, [hasApiConfig])

  const resolveNextExercise = useCallback(
    async function resolveNextExerciseResponse(
      response: NextExerciseResponse,
      remainingRetries: number,
    ): Promise<Exercise> {
      if (response.mode === 'ready') {
        return response.exercise
      }

      const verificationRun = await runPythonWithTests(
        response.candidate.referenceSolution,
        response.candidate.tests,
      )

      if (verificationRun.passed) {
        const confirmed = await confirmVerifiedExercise(response.candidate)
        return confirmed.exercise
      }

      if (remainingRetries > 0) {
        return resolveNextExerciseResponse(await fetchNextExercise(), remainingRetries - 1)
      }

      throw new Error('Generated exercise failed local verification.')
    },
    [],
  )

  const loadNextExercise = useCallback(async () => {
    if (!hasApiConfig) {
      return
    }

    setExerciseState('loading')
    setExerciseError('')

    try {
      const response = await fetchNextExercise()
      const exercise = await resolveNextExercise(response, 2)
      resetExerciseUi(exercise)
      setExerciseState('ready')
    } catch (error) {
      setExerciseState('error')
      setExerciseError(
        error instanceof Error ? error.message : 'Failed to load next exercise.',
      )
    }
  }, [hasApiConfig, resetExerciseUi, resolveNextExercise])

  const getCurrentLineContext = useCallback(() => {
    const view = editorViewRef.current

    if (!view) {
      return ''
    }

    const head = view.state.selection.main.head
    return view.state.doc.lineAt(head).text
  }, [])

  const sendHelperRequest = useCallback(
    async (message: string) => {
      if (!currentExercise || chatState === 'sending') {
        return
      }

      const trimmedMessage = message.trim()
      if (!trimmedMessage) {
        return
      }

      const history = chatMessages
      setChatState('sending')
      setChatError('')

      try {
        const response = await sendChatMessage({
          exerciseId: currentExercise.id,
          code,
          history,
          message: trimmedMessage,
        })

        setChatMessages((prev) => [
          ...prev,
          { role: 'user', content: trimmedMessage },
          { role: 'assistant', content: response.message },
        ])
        setChatUsedCount((count) => count + 1)
        setChatState('idle')
        setChatInput('')
      } catch (error) {
        setChatState('error')
        setChatError(error instanceof Error ? error.message : 'Chat request failed.')
      }
    },
    [chatMessages, chatState, code, currentExercise],
  )

  const handleRun = useCallback(async () => {
    if (runtimeState !== 'ready' || isRunning) {
      return
    }

    setIsRunning(true)
    setLastRun(null)

    if (currentExercise) {
      setRunCount((count) => count + 1)
    }

    try {
      const result = currentExercise
        ? await runPythonWithTests(code, currentExercise.tests)
        : await runPython(code)
      setLastRun(result)
    } catch (error) {
      setLastRun({
        status: 'error',
        stdout: '',
        stderr: error instanceof Error ? error.message : 'Python execution failed.',
        durationMs: 0,
        passed: false,
        tests: [],
      })
    } finally {
      setIsRunning(false)
    }
  }, [code, currentExercise, isRunning, runtimeState])

  const handleSubmit = useCallback(async () => {
    if (!currentExercise || !lastRun?.passed || submissionState === 'submitting') {
      return
    }

    setSubmissionState('submitting')
    setSubmissionError('')

    try {
      const result = await submitExercise({
        exerciseId: currentExercise.id,
        submittedCode: code,
        passed: true,
        runCount,
        recallUsedCount,
        chatUsedCount,
        timeSpentSeconds: Math.max(
          0,
          Math.round(((Date.now() - (exerciseStartedAt ?? Date.now())) / 1000) || 0),
        ),
        testResults: lastRun.tests,
      })

      const review = result.examinerReviewMd

      if (typeof review === 'string' && review.trim()) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: review },
        ])
      }

      setSubmissionState('success')
      await refreshAppState()
    } catch (error) {
      setSubmissionState('error')
      setSubmissionError(
        error instanceof Error ? error.message : 'Failed to submit the exercise.',
      )
    }
  }, [
    chatUsedCount,
    code,
    currentExercise,
    exerciseStartedAt,
    lastRun,
    recallUsedCount,
    refreshAppState,
    runCount,
    submissionState,
  ])

  const handleSkip = useCallback(async () => {
    if (!currentExercise || submissionState === 'submitting') {
      return
    }

    setSubmissionState('submitting')
    setSubmissionError('')

    try {
      const result = await submitExercise({
        exerciseId: currentExercise.id,
        submittedCode: code,
        passed: false,
        runCount,
        recallUsedCount,
        chatUsedCount,
        timeSpentSeconds: Math.max(
          0,
          Math.round(((Date.now() - (exerciseStartedAt ?? Date.now())) / 1000) || 0),
        ),
        abandoned: true,
        testResults: lastRun?.tests ?? [],
      })

      const review = result.examinerReviewMd

      if (typeof review === 'string' && review.trim()) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: review },
        ])
      }

      setSubmissionState('success')
      await refreshAppState()
      await loadNextExercise()
    } catch (error) {
      setSubmissionState('error')
      setSubmissionError(
        error instanceof Error ? error.message : 'Failed to skip the exercise.',
      )
    }
  }, [
    chatUsedCount,
    code,
    currentExercise,
    exerciseStartedAt,
    lastRun,
    loadNextExercise,
    recallUsedCount,
    refreshAppState,
    runCount,
    submissionState,
  ])

  const handleRecallSubmit = useCallback(async () => {
    const trimmedHint = recallInput.trim()

    if (!trimmedHint || recallState === 'loading') {
      return
    }

    setRecallState('loading')
    setRecallMessage('')

    try {
      const response = await requestRecall({
        code,
        hint: trimmedHint,
        lineContext: getCurrentLineContext(),
      })
      setRecallMessage(response.message)
      setRecallUsedCount((count) => count + 1)
      setRecallState('success')
    } catch (error) {
      setRecallState('error')
      setRecallMessage(error instanceof Error ? error.message : 'Recall request failed.')
    }
  }, [code, getCurrentLineContext, recallInput, recallState])

  useEffect(() => {
    let cancelled = false

    void getPyodide()
      .then(async () => {
        if (cancelled) {
          return
        }

        setRuntimeState('ready')

        try {
          await ensureJediLoaded()

          if (cancelled) {
            return
          }

          setCompletionState('ready')
        } catch (error) {
          if (cancelled) {
            return
          }

          setCompletionState('error')
          setCompletionError(
            error instanceof Error ? error.message : 'Failed to load Jedi.',
          )
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }

        setRuntimeState('error')
        setCompletionState('error')
        setRuntimeError(
          error instanceof Error ? error.message : 'Failed to load Pyodide.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        chatInputRef.current?.focus()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setRecallOpen(true)
        return
      }

      if (isEditableTarget(event.target)) {
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void handleRun()
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter') {
        event.preventDefault()
        void handleSubmit()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleRun, handleSubmit])

  useEffect(() => {
    let cancelled = false

    if (!hasApiConfig) {
      return
    }

    void Promise.all([
      fetchAppState(),
      fetchNextExercise().then((response) => resolveNextExercise(response, 2)),
    ])
      .then(([stateResponse, exercise]) => {
        if (cancelled) {
          return
        }

        setAppState(stateResponse)
        setBackendState('ready')
        setBackendError('')
        resetExerciseUi(exercise)
        setExerciseState('ready')
        setExerciseError('')
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }

        const message =
          error instanceof Error ? error.message : 'Failed to load initial app state.'

        setBackendState('error')
        setBackendError(message)
        setExerciseState('error')
        setExerciseError(message)
      })

    return () => {
      cancelled = true
    }
  }, [hasApiConfig, resetExerciseUi, resolveNextExercise])

  useEffect(() => {
    if (recallOpen) {
      requestAnimationFrame(() => {
        recallInputRef.current?.focus()
      })
    }
  }, [recallOpen])

  useEffect(() => {
    if (!currentExercise || !lastRun || chatState === 'sending') {
      return
    }

    const hasRunError = Boolean(lastRun.stderr.trim()) || lastRun.tests.some((test) => test.status === 'failed')

    if (!hasRunError) {
      return
    }

    const signature = JSON.stringify({
      exerciseId: currentExercise.id,
      stderr: lastRun.stderr,
      failedTests: lastRun.tests
        .filter((test) => test.status === 'failed')
        .map((test) => ({ name: test.name, message: test.message })),
    })

    if (lastAutoExplainSignatureRef.current === signature) {
      return
    }

    lastAutoExplainSignatureRef.current = signature
    void sendHelperRequest(buildRunErrorMessage(lastRun))
  }, [chatState, currentExercise, lastRun, sendHelperRequest])

  const canSubmit = Boolean(
    currentExercise && lastRun?.passed && !isRunning && submissionState !== 'success',
  )
  const resetCode = currentExercise?.starterCode ?? STARTER_CODE
  const failedTests = lastRun?.tests.filter((test) => test.status === 'failed') ?? []

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Milestone 7</p>
          <h1>Python Learning App</h1>
        </div>
        <div className="header-actions">
          <span className={`runtime-pill runtime-pill--${runtimeState}`}>
            {runtimeState === 'loading' && 'Loading Pyodide...'}
            {runtimeState === 'ready' && 'Runtime ready'}
            {runtimeState === 'error' && 'Runtime failed'}
          </span>
          <span className={`runtime-pill runtime-pill--${completionState}`}>
            {completionState === 'loading' && 'Loading Jedi...'}
            {completionState === 'ready' && 'Completions ready'}
            {completionState === 'error' && 'Completions failed'}
          </span>
          <button
            className="ghost-button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || submissionState === 'submitting'}
          >
            {submissionState === 'submitting' ? 'Submitting...' : 'Submit'}
          </button>
          <button
            className="primary-button"
            onClick={() => void handleRun()}
            disabled={runtimeState !== 'ready' || isRunning}
          >
            {isRunning ? 'Running...' : 'Run'}
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="side-panel">
          <h2>Prompt</h2>
          {exerciseState === 'ready' && currentExercise ? (
            <>
              <div className="prompt-meta">
                <span className="difficulty-chip">{currentExercise.difficultyBand}</span>
                {currentExercise.topics.map((topic) => (
                  <span key={topic.id} className="topic-chip">
                    {topic.displayName}
                  </span>
                ))}
              </div>
              <article className="prompt-card">
                <div className="prompt-markdown">{currentExercise.promptMd}</div>
              </article>
              <div className="prompt-actions">
                <button
                  className="ghost-button"
                  onClick={() => void handleSkip()}
                  disabled={submissionState === 'submitting'}
                >
                  Skip exercise
                </button>
                <button
                  className="ghost-button"
                  onClick={() => void loadNextExercise()}
                  disabled={submissionState === 'submitting'}
                >
                  Next exercise
                </button>
              </div>
            </>
          ) : (
            <div className="panel-card">
              <p className={`status-copy status-copy--${exerciseState}`}>
                {exerciseState === 'loading' && 'Loading exercise...'}
                {exerciseState === 'error' && exerciseError}
                {exerciseState === 'unconfigured' &&
                  'Worker config is missing, so the editor stays in local sample mode.'}
              </p>
            </div>
          )}

          <div className="panel-card">
            <h3>Current scope</h3>
            <ul>
              <li>Generated exercises verified locally before display</li>
              <li>Helper chat in the current exercise context</li>
              <li>Recall popup via Ctrl+K</li>
              <li>Automatic error explanation after failed runs</li>
            </ul>
          </div>

          <div className="panel-card">
            <h3>Backend state</h3>
            <p className={`status-copy status-copy--${backendState}`}>
              {backendState === 'loading' && 'Loading /api/state...'}
              {backendState === 'ready' &&
                `Loaded ${appState?.competenceMap.length ?? 0} topics from the worker.`}
              {backendState === 'error' && backendError}
              {backendState === 'unconfigured' && backendError}
            </p>
            {appState ? (
              <dl className="state-grid">
                <div>
                  <dt>Difficulty</dt>
                  <dd>{appState.currentDifficultyBand}</dd>
                </div>
                <div>
                  <dt>History</dt>
                  <dd>{appState.recentHistory.length} attempts</dd>
                </div>
                <div>
                  <dt>Topics</dt>
                  <dd>{appState.competenceMap.length}</dd>
                </div>
              </dl>
            ) : null}
          </div>
        </aside>

        <section className="editor-panel">
          <div className="editor-toolbar">
            <div>
              <h2>Editor</h2>
              <p>Run executes your solution and the exercise tests locally in the browser.</p>
            </div>
            <div className="toolbar-actions">
              <span className="run-counter">
                {runCount} {pluralize(runCount, 'run', 'runs')} this exercise
              </span>
              <button className="ghost-button" onClick={() => setRecallOpen(true)}>
                Recall
              </button>
              <button
                className="ghost-button"
                onClick={() => setCode(resetCode)}
                disabled={isRunning}
              >
                Reset code
              </button>
            </div>
          </div>

          <div className="editor-frame">
            <CodeMirror
              value={code}
              height="100%"
              theme={oneDark}
              extensions={editorExtensions}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                closeBrackets: true,
              }}
              onChange={setCode}
              onCreateEditor={(view) => {
                editorViewRef.current = view
              }}
            />
          </div>

          {recallOpen ? (
            <div className="recall-popup" role="dialog" aria-label="Syntax recall">
              <div className="recall-popup__header">
                <h3>Syntax Recall</h3>
                <button className="ghost-button" onClick={() => setRecallOpen(false)}>
                  Close
                </button>
              </div>
              <div className="recall-popup__body">
                <input
                  ref={recallInputRef}
                  className="chat-input chat-input--single"
                  value={recallInput}
                  onChange={(event) => setRecallInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setRecallOpen(false)
                    }

                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void handleRecallSubmit()
                    }
                  }}
                  placeholder="What are you trying to do?"
                />
                <button
                  className="ghost-button"
                  onClick={() => void handleRecallSubmit()}
                  disabled={recallState === 'loading'}
                >
                  {recallState === 'loading' ? 'Looking up...' : 'Recall'}
                </button>
              </div>
              {recallMessage ? (
                <pre className="output-block recall-output">{formatMessageContent(recallMessage)}</pre>
              ) : null}
            </div>
          ) : null}

          {completionState === 'error' ? (
            <p className="editor-note editor-note--error">{completionError}</p>
          ) : currentExercise ? (
            <p className="editor-note">
              Use <code>Ctrl+Enter</code> to run tests, <code>Ctrl+Shift+Enter</code> to submit,
              <code> Ctrl+K</code> for syntax recall, and <code>Ctrl+L</code> to focus chat.
            </p>
          ) : (
            <p className="editor-note">
              Start typing a name or press <code>Ctrl+Space</code> to request Jedi completions.
            </p>
          )}

          <section className="output-panel" aria-live="polite">
            <div className="output-header">
              <h2>Output</h2>
              {lastRun ? (
                <span
                  className={`run-status run-status--${
                    lastRun.passed === false || lastRun.status === 'error' ? 'error' : 'success'
                  }`}
                >
                  {lastRun.passed === true
                    ? 'Tests passed'
                    : lastRun.passed === false
                      ? 'Tests failed'
                      : 'Run finished'}
                  {' · '}
                  {Math.round(lastRun.durationMs)}ms
                </span>
              ) : null}
            </div>

            {runtimeState === 'error' ? (
              <pre className="output-block output-block--error">{runtimeError}</pre>
            ) : null}

            {!lastRun && runtimeState !== 'error' ? (
              <p className="output-placeholder">
                {currentExercise
                  ? 'Run the exercise to see stdout, stderr, and per-test results here.'
                  : 'Run the sample code to see stdout and Python tracebacks here.'}
              </p>
            ) : null}

            {lastRun?.tests.length ? (
              <div className="output-section">
                <h3>tests</h3>
                <div className="test-list">
                  {lastRun.tests.map((test) => (
                    <div key={test.name} className={`test-item test-item--${test.status}`}>
                      <div className="test-item__header">
                        <span>{test.name}</span>
                        <span>{test.status}</span>
                      </div>
                      {test.message ? <pre className="output-block">{test.message}</pre> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {lastRun?.stdout ? (
              <div className="output-section">
                <h3>stdout</h3>
                <pre className="output-block">{lastRun.stdout}</pre>
              </div>
            ) : null}

            {lastRun?.stderr ? (
              <div className="output-section">
                <h3>stderr</h3>
                <pre className="output-block output-block--error">{lastRun.stderr}</pre>
              </div>
            ) : null}

            {failedTests.length > 0 ? (
              <p className="editor-note editor-note--error">
                {failedTests.length} {pluralize(failedTests.length, 'test is', 'tests are')} still
                failing.
              </p>
            ) : null}
          </section>
        </section>

        <aside className="side-panel side-panel--chat">
          <div className="chat-header">
            <div>
              <h2>AI Chat</h2>
              <p>Helper chat resets when you move to a new exercise.</p>
            </div>
            <div className="chat-meta">
              <span className="run-counter">
                {chatUsedCount} {pluralize(chatUsedCount, 'chat', 'chats')}
              </span>
              <span className="run-counter">
                {recallUsedCount} {pluralize(recallUsedCount, 'recall', 'recalls')}
              </span>
            </div>
          </div>

          <div className="chat-thread">
            {chatMessages.length === 0 ? (
              <div className="panel-card">
                <p className="status-copy">
                  Ask for a hint, explanation, or error help. Failed runs will also auto-trigger a
                  short explanation here.
                </p>
              </div>
            ) : (
              chatMessages.map((entry, index) => (
                <div key={`${entry.role}-${index}`} className={`chat-message chat-message--${entry.role}`}>
                  <div className="chat-message__role">{entry.role === 'user' ? 'You' : 'AI'}</div>
                  <pre className="chat-message__content">{formatMessageContent(entry.content)}</pre>
                </div>
              ))
            )}
          </div>

          {submissionError ? <p className="editor-note editor-note--error">{submissionError}</p> : null}
          {chatError ? <p className="editor-note editor-note--error">{chatError}</p> : null}

          <div className="chat-composer">
            <textarea
              ref={chatInputRef}
              className="chat-input"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask for a hint, explanation, or approach..."
              rows={4}
            />
            <button
              className="primary-button"
              onClick={() => void sendHelperRequest(chatInput)}
              disabled={!currentExercise || chatState === 'sending' || !chatInput.trim()}
            >
              {chatState === 'sending' ? 'Sending...' : 'Send'}
            </button>
          </div>
        </aside>
      </main>
    </div>
  )
}

export default App
