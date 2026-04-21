import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { oneDark } from '@codemirror/theme-one-dark'
import './App.css'
import {
  fetchAppState,
  fetchNextExercise,
  getApiConfig,
  submitExercise,
  type AppState,
  type Exercise,
  type ExerciseSubmissionResult,
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
    hasApiConfig ? '' : 'Configure the worker to load hardcoded exercises.',
  )
  const [currentExercise, setCurrentExercise] = useState<Exercise | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [lastRun, setLastRun] = useState<PythonRunResult | null>(null)
  const [runCount, setRunCount] = useState(0)
  const [exerciseStartedAt, setExerciseStartedAt] = useState<number | null>(null)
  const [submissionState, setSubmissionState] = useState<SubmissionState>('idle')
  const [submissionError, setSubmissionError] = useState('')
  const [submissionResult, setSubmissionResult] = useState<ExerciseSubmissionResult | null>(null)

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

        return {
          from,
          options,
        }
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

  const loadNextExercise = useCallback(async () => {
    if (!hasApiConfig) {
      return
    }

    setExerciseState('loading')
    setExerciseError('')

    try {
      const { exercise } = await fetchNextExercise()
      setCurrentExercise(exercise)
      setCode(exercise.starterCode ?? '')
      setLastRun(null)
      setRunCount(0)
      setExerciseStartedAt(Date.now())
      setSubmissionState('idle')
      setSubmissionError('')
      setSubmissionResult(null)
      setExerciseState('ready')
    } catch (error) {
      setExerciseState('error')
      setExerciseError(
        error instanceof Error ? error.message : 'Failed to load next exercise.',
      )
    }
  }, [hasApiConfig])

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
    setSubmissionResult(null)

    try {
      const result = await submitExercise({
        exerciseId: currentExercise.id,
        submittedCode: code,
        passed: true,
        runCount,
        recallUsedCount: 0,
        chatUsedCount: 0,
        timeSpentSeconds: Math.max(
          0,
          Math.round(((Date.now() - (exerciseStartedAt ?? Date.now())) / 1000) || 0),
        ),
        testResults: lastRun.tests,
      })

      setSubmissionResult(result)
      setSubmissionState('success')
      await refreshAppState()
    } catch (error) {
      setSubmissionState('error')
      setSubmissionError(
        error instanceof Error ? error.message : 'Failed to submit the exercise.',
      )
    }
  }, [
    code,
    currentExercise,
    exerciseStartedAt,
    lastRun,
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
    setSubmissionResult(null)

    try {
      const result = await submitExercise({
        exerciseId: currentExercise.id,
        submittedCode: code,
        passed: false,
        runCount,
        recallUsedCount: 0,
        chatUsedCount: 0,
        timeSpentSeconds: Math.max(
          0,
          Math.round(((Date.now() - (exerciseStartedAt ?? Date.now())) / 1000) || 0),
        ),
        abandoned: true,
        testResults: lastRun?.tests ?? [],
      })

      setSubmissionResult(result)
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
    code,
    currentExercise,
    exerciseStartedAt,
    lastRun,
    loadNextExercise,
    refreshAppState,
    runCount,
    submissionState,
  ])

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

    void Promise.all([fetchAppState(), fetchNextExercise()])
      .then(([stateResponse, exerciseResponse]) => {
        if (cancelled) {
          return
        }

        setAppState(stateResponse)
        setBackendState('ready')
        setBackendError('')

        setCurrentExercise(exerciseResponse.exercise)
        setCode(exerciseResponse.exercise.starterCode ?? '')
        setLastRun(null)
        setRunCount(0)
        setExerciseStartedAt(Date.now())
        setSubmissionState('idle')
        setSubmissionError('')
        setSubmissionResult(null)
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
  }, [hasApiConfig])

  const canSubmit = Boolean(currentExercise && lastRun?.passed && !isRunning)
  const resetCode = currentExercise?.starterCode ?? STARTER_CODE
  const failedTests = lastRun?.tests.filter((test) => test.status === 'failed') ?? []

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Milestone 4</p>
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
                {exerciseState === 'loading' && 'Loading hardcoded exercise...'}
                {exerciseState === 'error' && exerciseError}
                {exerciseState === 'unconfigured' &&
                  'Worker config is missing, so the editor stays in local sample mode.'}
              </p>
            </div>
          )}

          <div className="panel-card">
            <h3>Current scope</h3>
            <ul>
              <li>Hardcoded exercise fetch loop through the worker</li>
              <li>Browser-side test execution in Pyodide</li>
              <li>Submit, skip, and next exercise controls</li>
              <li>Competence map refresh after submission</li>
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
              <p>
                {currentExercise
                  ? 'Run executes your solution and the exercise tests locally in the browser.'
                  : 'Everything executes locally in the browser, including completions.'}
              </p>
            </div>
            <div className="toolbar-actions">
              <span className="run-counter">
                {runCount} {pluralize(runCount, 'run', 'runs')} this exercise
              </span>
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
            />
          </div>

          {completionState === 'error' ? (
            <p className="editor-note editor-note--error">{completionError}</p>
          ) : currentExercise ? (
            <p className="editor-note">
              Use <code>Ctrl+Enter</code> to run tests and <code>Ctrl+Shift+Enter</code> to
              submit after the last run is green.
            </p>
          ) : (
            <p className="editor-note">
              Start typing a name or press <code>Ctrl+Space</code> to request Jedi
              completions.
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

        <aside className="side-panel">
          <h2>Session</h2>
          <p>
            LLM features are still intentionally off. This pane now shows the local
            submission loop instead.
          </p>

          <div className="panel-card">
            <h3>Latest submission</h3>
            {submissionResult ? (
              <div className="submission-summary">
                <p className={`status-copy status-copy--${submissionResult.passed ? 'ready' : 'error'}`}>
                  {submissionResult.passed ? 'Passed and recorded.' : 'Recorded without a pass.'}
                </p>
                <p>Score: {submissionResult.perAttemptScore.toFixed(2)}</p>
                {submissionResult.examinerReviewMd ? (
                  <pre className="output-block">{submissionResult.examinerReviewMd}</pre>
                ) : null}
              </div>
            ) : submissionState === 'submitting' ? (
              <p className="status-copy status-copy--loading">Submitting attempt...</p>
            ) : submissionState === 'error' ? (
              <p className="status-copy status-copy--error">{submissionError}</p>
            ) : (
              <p className="status-copy">Run the exercise, then submit once the tests pass.</p>
            )}
          </div>

          <div className="panel-card">
            <h3>Recent history</h3>
            {appState?.recentHistory.length ? (
              <div className="history-list">
                {appState.recentHistory.slice(0, 5).map((attempt) => (
                  <div key={attempt.id} className="history-item">
                    <span>{attempt.exerciseId}</span>
                    <span>{attempt.perAttemptScore.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="status-copy">No attempts recorded yet.</p>
            )}
          </div>
        </aside>
      </main>
    </div>
  )
}

export default App
