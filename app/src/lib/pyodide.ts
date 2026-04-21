import type { PyodideInterface } from 'pyodide'

const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/'

let pyodidePromise: Promise<PyodideInterface> | null = null
let jediPromise: Promise<void> | null = null
let pyodideQueue: Promise<void> = Promise.resolve()

export type PythonRunResult = {
  status: 'success' | 'error'
  stdout: string
  stderr: string
  durationMs: number
  passed: boolean | null
  tests: PythonTestResult[]
}

export type PythonTestResult = {
  name: string
  status: 'passed' | 'failed'
  message: string
}

export type PythonCompletion = {
  name: string
  kind: string
  detail: string
  docstring: string
}

function toJsValue<T>(value: unknown) {
  if (typeof (value as { toJs?: unknown })?.toJs === 'function') {
    return (value as { toJs: (options?: object) => T }).toJs({
      dict_converter: Object.fromEntries,
    })
  }

  return value as T
}

function destroyProxy(value: unknown) {
  if (typeof (value as { destroy?: unknown })?.destroy === 'function') {
    ;(value as { destroy: () => void }).destroy()
  }
}

async function withPyodideLock<T>(work: () => Promise<T>) {
  const result = pyodideQueue.then(work, work)
  pyodideQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export async function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = import(
      /* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`
    ).then(({ loadPyodide }) => loadPyodide({ indexURL: PYODIDE_INDEX_URL }))
  }

  return pyodidePromise
}

export async function ensureJediLoaded() {
  if (!jediPromise) {
    jediPromise = withPyodideLock(async () => {
      const pyodide = await getPyodide()
      await pyodide.loadPackage('jedi')
    })
  }

  return jediPromise
}

export async function runPython(code: string): Promise<PythonRunResult> {
  return withPyodideLock(async () => {
    const pyodide = await getPyodide()
    const startedAt = performance.now()

    pyodide.globals.set('__user_code', code)

    try {
      const resultProxy = await pyodide.runPythonAsync(`
import io
import traceback
from contextlib import redirect_stdout, redirect_stderr

stdout = io.StringIO()
stderr = io.StringIO()
status = "success"

with redirect_stdout(stdout), redirect_stderr(stderr):
    try:
        exec(__user_code, {"__name__": "__main__"})
    except Exception:
        status = "error"
        traceback.print_exc()

{
    "status": status,
    "stdout": stdout.getvalue(),
    "stderr": stderr.getvalue(),
}
`)

      const result = toJsValue<Omit<PythonRunResult, 'durationMs'>>(resultProxy)
      destroyProxy(resultProxy)

      return {
        ...result,
        durationMs: performance.now() - startedAt,
        passed: null,
        tests: [],
      }
    } finally {
      pyodide.globals.delete('__user_code')
    }
  })
}

export async function runPythonWithTests(
  code: string,
  tests: string,
): Promise<PythonRunResult> {
  return withPyodideLock(async () => {
    const pyodide = await getPyodide()
    const startedAt = performance.now()

    pyodide.globals.set('__user_code', code)
    pyodide.globals.set('__tests_code', tests)

    try {
      const resultProxy = await pyodide.runPythonAsync(`
import io
import sys
import traceback
import types
from contextlib import redirect_stdout, redirect_stderr

stdout = io.StringIO()
stderr = io.StringIO()
status = "success"
passed = True
test_results = []

previous_solution = sys.modules.get("solution")
solution_module = types.ModuleType("solution")
solution_module.__dict__["__name__"] = "solution"

with redirect_stdout(stdout), redirect_stderr(stderr):
    try:
        exec(__user_code, solution_module.__dict__)
        sys.modules["solution"] = solution_module

        test_namespace = {"__name__": "exercise_tests"}
        exec(__tests_code, test_namespace)
        test_functions = sorted(
            [
                (name, value)
                for name, value in test_namespace.items()
                if name.startswith("test_") and callable(value)
            ],
            key=lambda item: item[0],
        )

        if not test_functions:
            passed = False
            test_results.append(
                {
                    "name": "test_collection",
                    "status": "failed",
                    "message": "No test_ functions were defined.",
                }
            )

        for name, test_function in test_functions:
            try:
                test_function()
                test_results.append(
                    {
                        "name": name,
                        "status": "passed",
                        "message": "",
                    }
                )
            except Exception:
                passed = False
                test_results.append(
                    {
                        "name": name,
                        "status": "failed",
                        "message": traceback.format_exc(),
                    }
                )
    except Exception:
        status = "error"
        passed = False
        traceback.print_exc()
    finally:
        if previous_solution is None:
            sys.modules.pop("solution", None)
        else:
            sys.modules["solution"] = previous_solution

{
    "status": status,
    "stdout": stdout.getvalue(),
    "stderr": stderr.getvalue(),
    "passed": passed and status == "success",
    "tests": test_results,
}
`)

      const result = toJsValue<Omit<PythonRunResult, 'durationMs'>>(resultProxy)
      destroyProxy(resultProxy)

      return {
        ...result,
        durationMs: performance.now() - startedAt,
      }
    } finally {
      pyodide.globals.delete('__user_code')
      pyodide.globals.delete('__tests_code')
    }
  })
}

export async function getPythonCompletions(
  code: string,
  line: number,
  column: number,
) {
  await ensureJediLoaded()

  return withPyodideLock(async () => {
    const pyodide = await getPyodide()

    pyodide.globals.set('__completion_code', code)
    pyodide.globals.set('__completion_line', line)
    pyodide.globals.set('__completion_column', column)

    try {
      const resultProxy = await pyodide.runPythonAsync(`
import jedi

script = jedi.Script(code=__completion_code, path="solution.py")
completions = script.complete(__completion_line, __completion_column)

[
    {
        "name": completion.name,
        "kind": completion.type,
        "detail": completion.description,
        "docstring": completion.docstring(raw=True),
    }
    for completion in completions
]
`)

      const result = toJsValue<PythonCompletion[]>(resultProxy)
      destroyProxy(resultProxy)
      return result
    } finally {
      pyodide.globals.delete('__completion_code')
      pyodide.globals.delete('__completion_line')
      pyodide.globals.delete('__completion_column')
    }
  })
}
