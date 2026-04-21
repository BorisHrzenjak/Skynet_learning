# Python Learning App — Design Document

> **Audience:** AI coding agent (Claude Code, Codex, Pi, OpenCode, etc.) implementing this app, with the human user reviewing.
>
> **Status:** v1 design, locked in via interview. Open questions explicitly marked.

---

## 1. One-paragraph summary

A single-user, browser-only Python learning web app. The user works through LLM-generated Python exercises with an in-browser editor (CodeMirror 6 + Jedi LSP via Pyodide), runs code locally in the browser via Pyodide, and receives result-oriented feedback from an LLM. The LLM is reachable on demand (chat panel and explicit hotkeys for syntax recall) and triggers automatically on a small set of events (run errors, exercise submission, prolonged idle). The app maintains a transparent competence map per topic and adapts exercise difficulty based on measured performance. Backend is a small Cloudflare Worker proxying OpenRouter (for LLM calls) and Cloudflare D1 (for state). No installation required; works from any modern browser including a locked-down work computer.

---

## 2. Core principles (read first, refer back when in doubt)

These principles override feature requests if they conflict. When making any judgment call during implementation, return to these.

1. **Default to silence; the LLM earns the right to speak.** No ghost-text completion, no unsolicited suggestions while typing, no chatter. The LLM acts only on explicit user request or on a small allowlisted set of events. Every interjection should be one the user would thank it for.

2. **Result-oriented, not opinion-oriented.** If the user's code passes the tests, the exercise is passed. Full stop. No style penalties, no "the right way to do it," no deductions for unidiomatic solutions. Alternatives are offered as *information*, never as correction. The system prompt for the examiner explicitly forbids phrases like "the better way," "the proper way," or "more Pythonic."

3. **The smallest learnable loop is the highest-leverage thing.** The loop is: open app → get exercise → write code → run/test → get feedback → next exercise. Everything else is extension. If the loop isn't great, no amount of additional features fixes it.

4. **Transparent over magical.** The user wants to see how the system models them. Stats are visible, the difficulty progression is explainable, the system prompts are inspectable. No hidden gamification, no slot-machine reward design.

5. **Friction kills sessions.** The whole reason this app exists is that the user bounces when frustrated. Setup friction, syntax-recall friction, "where is the next exercise" friction — all are session-killers. Optimize aggressively against friction in the core loop.

6. **Single-user simplicity wins over generality.** No abstractions for "future users." No auth flows. No tenancy. If a feature would require designing for hypothetical others, push back and confirm with the user.

---

## 3. Tech stack (decided)

| Layer | Choice | Notes |
|---|---|---|
| Frontend framework | React + Vite + TypeScript | Standard. No Next.js; this is a single-page app, not a content site. |
| Editor | CodeMirror 6 | Lighter and more extensible than Monaco; better fit for custom inline UI. |
| Python runtime | Pyodide (in-browser via WebAssembly) | All Python execution happens client-side. No server-side code execution. |
| LSP | Jedi, running inside Pyodide | Pyright-in-Worker is a documented future upgrade, NOT v1. |
| Backend | Cloudflare Workers | Single Worker, ~5 endpoints. |
| Database | Cloudflare D1 (SQLite) | Colocated with Worker; sub-ms queries. |
| LLM gateway | OpenRouter | OpenAI-compatible API. Model is configurable per role. |
| Deployment | `wrangler deploy` for the Worker; Cloudflare Pages for the static frontend. | One vendor, one CLI. |
| Styling | Tailwind CSS | Standard, fast to iterate. |

### LLM model configuration

Model IDs are NOT hardcoded. Create `src/config/models.ts` with one entry per LLM role:

```ts
export const MODELS = {
  generator: 'anthropic/claude-sonnet-4.6',
  examiner:  'anthropic/claude-sonnet-4.6',
  helper:    'z-ai/glm-5.1',
  recall:    'z-ai/glm-5.1',
} as const;
```

Defaults shown above are starting points. The user will tune.

---

## 4. Architecture

### Frontend (browser)

A single-page React app. Three main panes plus floating UI:

```
+---------------------------------------------------------+
|  [App header: title, settings cog, stats link]           |
+---------+------------------------------------+----------+
|         |                                    |          |
| Prompt  |          Editor (CodeMirror 6)     |   AI     |
| (left,  |                                    |   Chat   |
| collap- |                                    | (right)  |
| sible)  |                                    |          |
|         |                                    |          |
|         +------------------------------------+          |
|         |     Test results / output strip    |          |
|         |     (collapsible, bottom of editor)|          |
+---------+------------------------------------+----------+
```

- **Editor gets the most horizontal space.** Default split roughly 20% / 55% / 25%.
- **Exercise prompt pane** is collapsible.
- **Chat pane** is collapsible.
- **Test results / output** appear in a strip at the bottom of the editor pane (also collapsible).
- **Syntax-recall popup** floats over the editor near the cursor when invoked.
- **Single dark theme.** Pick one good one (e.g., One Dark or Tokyo Night). No theme picker in v1.

### Backend (Cloudflare Worker)

Five endpoints. All return JSON. All accept JSON. No auth on the endpoints themselves; instead a shared static token in a header (configured via Workers Secrets), checked by middleware.

| Endpoint | Purpose |
|---|---|
| `POST /api/exercise/next` | Returns the next exercise based on competence model. May trigger generation (with verify loop) or return a cached one. |
| `POST /api/exercise/submit` | User submits a solution. Records the attempt, updates competence scores, returns the examiner's review. |
| `POST /api/chat` | Free-form chat with the LLM in the context of the current exercise. |
| `POST /api/recall` | Syntax-recall hotkey. Takes a natural-language hint + current code context, returns 2-3 syntax options. |
| `GET /api/state` | Returns the user's competence map, recent history, and current settings (for the stats page and app initialization). |
| `POST /api/settings` | Update settings (cost cap, model overrides, preferred topics). |

### Data flow

1. Browser loads, calls `GET /api/state` to get competence map and settings.
2. User clicks "next exercise" (default action on app load): browser calls `POST /api/exercise/next`. Backend either generates+verifies a new exercise or returns a cached one. Browser displays it.
3. User writes code in the editor. Pyodide handles execution and Jedi handles completions, both in-browser. No backend calls.
4. User clicks Run: Pyodide executes the code and the test suite client-side. Results display in the bottom strip.
5. **On run with errors:** browser optionally auto-fires a chat message asking the LLM to explain (configurable; default on). LLM does NOT auto-fix; explanation only.
6. User clicks Submit: browser calls `POST /api/exercise/submit` with code + test results + interaction signals (helper used? chat used? time spent?). Backend stores the attempt, updates competence, calls examiner LLM, returns the review.
7. User clicks "next" → loop.

---

## 5. Data model (Cloudflare D1)

```sql
-- Topic taxonomy. Seed with the list in §6. Editable later.
CREATE TABLE topics (
  id TEXT PRIMARY KEY,           -- e.g. 'pathlib', 'comprehensions'
  display_name TEXT NOT NULL,
  difficulty_band TEXT NOT NULL  -- 'basic' | 'intermediate' | 'advanced'
);

-- Verified, cached exercises. One row per unique exercise.
CREATE TABLE exercises (
  id TEXT PRIMARY KEY,           -- uuid
  prompt_md TEXT NOT NULL,       -- the exercise description (markdown)
  starter_code TEXT,             -- optional starter code shown in editor
  reference_solution TEXT NOT NULL,  -- one valid solution; not shown to user pre-submit
  tests TEXT NOT NULL,           -- pytest-style tests, run via Pyodide
  difficulty_band TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,     -- content hash for dedup
  created_at INTEGER NOT NULL,
  parent_exercise_id TEXT,       -- if this is a variant of another, points to parent
  FOREIGN KEY (parent_exercise_id) REFERENCES exercises(id)
);

-- Tag table: many-to-many between exercises and topics.
CREATE TABLE exercise_topics (
  exercise_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  PRIMARY KEY (exercise_id, topic_id),
  FOREIGN KEY (exercise_id) REFERENCES exercises(id),
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);

-- One row per submission attempt.
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL,
  submitted_code TEXT NOT NULL,
  passed INTEGER NOT NULL,        -- 0 or 1, based on tests only
  per_attempt_score REAL NOT NULL,-- 0.0 to 1.0, per the formula in §7
  run_count INTEGER NOT NULL,     -- how many times user ran code before submit
  recall_used_count INTEGER NOT NULL,
  chat_used_count INTEGER NOT NULL,
  time_spent_seconds INTEGER NOT NULL,
  examiner_review_md TEXT,        -- the LLM's review, stored for history
  created_at INTEGER NOT NULL,
  FOREIGN KEY (exercise_id) REFERENCES exercises(id)
);

-- Per-topic rolling competence score. One row per topic.
-- Re-derivable from attempts table; cached here for speed.
CREATE TABLE competence (
  topic_id TEXT PRIMARY KEY,
  score REAL NOT NULL,            -- rolling average of last 10 attempt scores tagged with this topic
  attempt_count INTEGER NOT NULL, -- total attempts on this topic
  last_updated INTEGER NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES topics(id)
);

-- App settings. Single row, id=1.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cost_cap_daily_usd REAL,        -- nullable; if null, no cap
  cost_cap_monthly_usd REAL,
  models_json TEXT NOT NULL,      -- overrides for src/config/models.ts defaults
  preferred_topics_json TEXT,     -- nullable; if set, generator biases toward these
  unlock_thresholds_json TEXT NOT NULL  -- e.g. {"intermediate": 0.8, "advanced": 0.85}
);

-- Daily LLM spend tracking, for cost cap enforcement.
CREATE TABLE llm_spend (
  date TEXT PRIMARY KEY,          -- YYYY-MM-DD
  estimated_usd REAL NOT NULL
);
```

### Notes

- **The `attempts` table is the source of truth.** The `competence` table is a cached rollup. If competence ever looks wrong, recompute from `attempts`.
- **`per_attempt_score` is computed at submit time and stored.** Don't recompute it later from raw signals — the scoring formula may evolve, and historical scores should reflect the formula at the time they were generated. (If you change the formula, leave old scores as-is.)
- **`tests`** is stored as a string of Python code that Pyodide can execute alongside the user's submission. See §8 for the format.

---

## 6. Topic taxonomy (seed list)

Seed the `topics` table with this list. The user may add/remove topics later via direct DB edit (no UI for it in v1).

**Basic:**
- `variables`, `numbers_and_strings`, `lists`, `tuples`, `dicts`, `sets`, `booleans_and_conditionals`, `loops`, `functions_basic`, `string_methods`, `formatting_fstrings`, `input_output_print`

**Intermediate:**
- `comprehensions`, `pathlib`, `file_io`, `exceptions`, `classes_basic`, `dataclasses`, `iterators`, `generators`, `decorators_basic`, `context_managers`, `typing_basic`, `regex_basic`, `json`, `csv`, `cli_argparse`, `datetime`, `collections_module`

**Advanced:**
- `decorators_advanced`, `generators_advanced`, `typing_advanced`, `metaclasses`, `async_basic`, `functools`, `itertools`, `pattern_matching`, `protocols_abstractbase`

This is a starting list. ~28 topics across three bands. Adjust as the user discovers gaps.

---

## 7. Competence model

### Per-attempt score (computed at submit time)

```
1.00  → passed first run, no helper used, no chat used
0.85  → passed first run, used recall hotkey (any number of times)
0.70  → passed within 3 runs, no helper or chat
0.55  → passed within 3 runs, used helper or chat
0.40  → passed eventually (>3 runs), with help
0.20  → passed only after multiple chat messages requesting substantial help
0.00  → skipped or abandoned
```

Implementation note: this is a decision tree on the recorded signals. Implement as a clear function in `src/lib/scoring.ts` (frontend computes signals, sends to backend; backend recomputes the score authoritatively before storing).

### Rolling average per topic

For each topic, the competence score is the **simple average of the per-attempt scores from the most recent 10 attempts tagged with that topic.** If fewer than 10 attempts exist, average over what's there.

**Important:** an exercise tagged with multiple topics contributes its per-attempt score to *each* of those topics' rolling windows. (e.g., an exercise tagged `pathlib` and `file_io` updates both topics' rolling averages.)

### Difficulty unlocking

- All `basic` exercises are available from day 1.
- `intermediate` exercises unlock when the **average competence across all `basic` topics with ≥3 attempts** is ≥ 0.80.
- `advanced` exercises unlock when the same metric for `intermediate` topics is ≥ 0.85.

The thresholds are stored in `settings.unlock_thresholds_json` so they can be tuned.

After unlock, lower-band exercises continue to appear at lower frequency (for retention). Suggested mix once intermediate is unlocked: 70% intermediate, 30% basic. After advanced unlocks: 50% advanced, 35% intermediate, 15% basic. These ratios are guidance; tune in the generator.

---

## 8. Exercise generation pipeline

When `POST /api/exercise/next` is called:

1. **Determine target topic and difficulty.**
   - Read competence map.
   - Sample a topic, weighted toward weak topics (lower competence score = higher weight). Apply the difficulty mix from §7.
   - Apply variety: don't pick a topic that was used in the last 2 exercises unless no other option.
   - If `preferred_topics_json` is set in settings (the "what do you feel like working on today" mode), restrict the sample to those topics.

2. **Decide: generate fresh or serve from cache?**
   - 70% of the time, attempt to serve from cache: query `exercises` for a row matching the topic+difficulty that the user hasn't attempted in the last 30 days. If found, return it.
   - 30% of the time, or if no cache hit, generate fresh.
   - Variant generation (spaced-repetition mode): occasionally pick a previously-passed exercise (>30 days old) and generate a *variant* of it via the LLM, tagged with the same topics, with `parent_exercise_id` set.

3. **Generate (when needed).**
   - Call the generator LLM with: target topic(s), target difficulty, list of recent exercise hashes/summaries to avoid duplication, and the Pyodide-package-availability constraint (see §11).
   - LLM returns structured JSON: `{ prompt_md, starter_code, reference_solution, tests }`.

4. **Verify.**
   - Run `reference_solution` against `tests` in a Pyodide context (server-side: the Worker can ship Pyodide, OR the Worker can return the candidate to the browser for verification before display — see §13 open question).
   - If green, hash the exercise, insert into `exercises`, return to user.
   - If red, ask the LLM to fix (max 2 retries). If still failing, discard and regenerate from step 3 (max 1 outer retry). If everything fails, return an error and surface it in the UI ("couldn't generate a fresh exercise; try again").

### Generator prompt requirements

The generator prompt must include:
- The specified topic(s) and difficulty band.
- The Pyodide constraint: stdlib only by default, plus an explicit allowlist of any additional packages.
- A directive to produce **a single self-contained Python file**, no external file I/O assumed (or, if file I/O is the topic, simulate via in-memory paths or `io.StringIO`).
- The required output JSON schema.
- The instruction that `tests` should be a `pytest`-style test file that imports from the user's submission module (use a known module name convention like `solution`).

### Examiner prompt requirements (system prompt for `POST /api/exercise/submit`)

The examiner is given: the exercise prompt, the user's code, the test results (pass/fail per test), and the user's interaction signals. The examiner is **NOT** given the reference solution when judging pass/fail. Pass/fail comes from the test results, period.

The examiner's response is structured into three sections:
1. **Result:** pass or fail, derived from test results.
2. **What worked** (only if passed): brief, honest observations about the user's approach. Not flattery.
3. **Worth knowing** (optional, max 1-2 notes): alternative approaches, idiomatic variations, stdlib features the user might find useful. *Phrased as "another way is..." not "the better way is..."*

The system prompt must explicitly forbid:
- "The right way," "the proper way," "more Pythonic," "the correct approach"
- Style criticism for code that passed
- Long code-review essays (cap at ~150 words for the whole review)

---

## 9. LLM roles and prompts

Four distinct LLM roles, each with its own system prompt and configurable model:

| Role | When called | Model default | Notes |
|---|---|---|---|
| `generator` | When generating a new exercise | Claude Sonnet 4.6 | Must produce structured JSON. Instruction-following matters. |
| `examiner` | On exercise submission | Claude Sonnet 4.6 | Result-oriented. Forbidden phrases enforced via system prompt. |
| `helper` | When user opens chat panel and asks something | GLM-5.1 (cheap) | Conversational. Can explain, hint, but should not write the solution unprompted. |
| `recall` | On syntax-recall hotkey | GLM-5.1 (cheap) | Returns 2-3 idiomatic syntax options for a natural-language hint. |

Each role's system prompt lives in `src/prompts/{role}.ts`. Keep them as plain strings, not templates — the agent should be able to read and modify them easily.

### Helper prompt key constraints

- The helper sees: current exercise, user's current code, conversation history.
- The helper should **explain, not solve.** Acceptable: explain what an error means, suggest an approach, point at relevant stdlib. Not acceptable: write the working solution.
- If the user explicitly asks "just give me the answer," the helper can — but with a brief note that solving themselves is the learning. (One sentence, no preaching.)

### Recall prompt key constraints

- Input: user's hint (e.g., "read all lines from a file"), current code context (the line/function they're in).
- Output: 2-3 syntax options, each with a one-line comment about when to use it.
- Format: code blocks, minimal prose.
- The user types the code themselves; the recall helper does NOT auto-insert.

---

## 10. UI specifics

### Editor (CodeMirror 6)

- Python syntax highlighting.
- Jedi-powered completion (symbol completion, signature help, hover docstrings).
- Keybindings:
  - `Ctrl+Enter` (or `Cmd+Enter`): Run.
  - `Ctrl+Shift+Enter`: Submit (only enabled when last run was green).
  - `Ctrl+K`: Open syntax-recall popup at cursor.
  - `Ctrl+L` (or similar): Focus chat input.
- Tab completion accepts the current LSP suggestion; does NOT accept any AI ghost text (because there is none).
- Line numbers, current-line highlight, matching-bracket highlight. Standard editor affordances.

### Exercise prompt pane (left)

- Renders the exercise's `prompt_md` as markdown.
- Above the prompt: small chips showing topic tags and difficulty band.
- Below the prompt: a "skip exercise" button (records as score 0.0, advances to next).
- Collapsible via a chevron.

### AI chat pane (right)

- Conversation history with the LLM for the current exercise (cleared when moving to a new exercise; consider persisting per-exercise as a future enhancement, but not v1).
- Input box at the bottom.
- Subtle "want a hint?" pill appears in this pane after 20-30min of inactivity on the current exercise (see §12). Dismissible. Appears once per exercise max.
- Collapsible via a chevron.

### Test results / output strip (bottom of editor)

- Shows stdout/stderr from the last run.
- Shows test results: pass/fail per test, with assertion messages on failure.
- Cleared on each Run.

### Syntax-recall popup

- Triggered by `Ctrl+K`. Floats near cursor.
- Single text input: "what are you trying to do?"
- On Enter, calls `POST /api/recall`, displays response inline (2-3 code options).
- Press Escape to dismiss. The user types code themselves; nothing is auto-inserted.

### Stats page

> **OPEN QUESTION — DO NOT BUILD YET. Ask the user before implementing.**
>
> The user wants this page but the layout has not been designed. Surface this before building so it can be sketched.

Sketch placeholder: per-topic competence scores visualized somehow, recent attempts list, current difficulty band, total time spent, total LLM spend.

### Settings page

- Cost caps (daily and monthly USD). Nullable.
- Model overrides per role (with the defaults from `src/config/models.ts` shown).
- "Preferred topics" multi-select (the "what do you feel like working on today" mode). Empty = no restriction.
- Difficulty unlock thresholds (advanced; default values shown).

---

## 11. Pyodide constraints

All Python execution happens in Pyodide. The exercise generator MUST respect what's available.

### Default constraint

- **Stdlib only.**

### Allowlisted additional packages

To start, only stdlib. As the user discovers Pyodide-compatible packages they want exercises for, add them to a config file (`src/config/pyodide_packages.ts`). The generator reads this list and includes it in the prompt as available imports.

### Forbidden patterns (for the generator to avoid)

- `subprocess`, `os.system`, anything spawning processes
- Real network I/O (`urllib`, `requests`, `socket`) — Pyodide has limited support, and exercises shouldn't depend on external services
- Real file I/O against the OS filesystem. Use `io.StringIO`, `io.BytesIO`, or Pyodide's virtual FS.
- Anything requiring `tkinter`, native GUI, or system-specific APIs.

If file I/O is the *topic* of the exercise (e.g., `pathlib`), the exercise should set up an in-memory or virtual-FS scenario (Pyodide supports `pyodide.FS` for this, or the exercise can build a temp dir via `tempfile`).

---

## 12. Event triggers (when the LLM speaks unprompted)

Per the "default to silence" principle, the LLM only acts unprompted on these events:

1. **On Run with errors.** Browser auto-fires a chat message: "I just ran the code and got this error: [error]. Can you explain what's going wrong?" The LLM responds in the chat pane. The user can disable this behavior in settings.
2. **On Submit.** The examiner is called automatically. Its review appears in the chat pane (and is also stored in `attempts.examiner_review_md`).
3. **On prolonged inactivity (20-30 min on the same exercise).** A small "want a hint?" pill appears in the chat pane. Non-modal. Appears once per exercise. Dismissed by the user OR fired by them = doesn't reappear.

That's it. No other unprompted LLM calls.

---

## 13. Open questions for the implementing agent to surface

Before implementing each of these, surface the question to the user:

1. **Stats page layout.** Not yet designed. Ask user to sketch or describe before building.
2. **Where does verification run?** Two options: (a) in the Worker via a server-side Pyodide build, which is heavy and adds complexity; (b) the Worker returns a candidate exercise to the browser, which verifies it locally before displaying it to the user (faster, simpler, but a malformed exercise might briefly reach the client). **Recommendation: option (b)** — the browser already has Pyodide loaded, the verification is fast, and the user never has to see the verification flicker because the UI can show a brief "preparing exercise..." state. Confirm with user.
3. **Per-exercise chat persistence.** Currently chat history is cleared between exercises. Worth persisting? Probably yes for review purposes, but not a v1 priority.
4. **Cost estimate accuracy.** The cost cap requires estimating LLM spend per call. OpenRouter returns token counts in responses; estimate using published per-model rates. Build a small `src/lib/cost.ts` with the per-model rates as a config. Confirm the user wants to maintain this themselves vs. fetching live rates.
5. **Initial seed exercises.** Should the app start with zero cached exercises (everything generated on first encounter) or should we pre-generate a small batch for the basic topics during setup? Recommendation: zero — generate on demand. The user prefers variety and the cache will fill naturally.

---

## 14. Explicitly NOT in v1

Do not build any of the following without explicit user confirmation. If a feature request during implementation seems to imply one of these, stop and ask.

- Multi-user, accounts, sharing, social features
- Authentication beyond a static token in a header
- Multi-file editing or "projects" spanning multiple files
- Multi-session work units
- Mobile or tablet-responsive design (desktop browser only)
- Pyright LSP (Jedi only)
- Ghost-text completion or any Copilot-style auto-suggestion
- Pre-generation queue for exercises
- Voice input or text-to-speech
- Theme picker or custom color schemes (one good dark theme, picked once)
- Export progress, share results, leaderboards
- Other languages beyond Python
- Anki-style spaced repetition with explicit review schedules (variant-based resurfacing only)
- Tutorials, lesson explanations, or non-exercise teaching content
- Difficulty granularity beyond basic/intermediate/advanced
- Streaks, XP, badges, gamification of any kind
- Public exercise sharing or community features
- Integration with external editors

---

## 15. Implementation order (suggested)

The agent should work in this order. Each milestone is a working, testable state — don't skip ahead.

### Milestone 1: Editor in browser
- Vite + React + TS scaffold.
- CodeMirror 6 editor with Python syntax highlighting.
- Pyodide loaded; "Run" button executes code in editor and shows stdout in a strip below.
- No backend yet. No exercises. Just an editor that runs Python.

### Milestone 2: LSP (Jedi)
- Jedi running in Pyodide.
- Wire Jedi completions into CodeMirror (symbol completion at minimum; signature help and hover if straightforward).
- No LLM yet.

### Milestone 3: Cloudflare backend skeleton
- Worker + D1 set up via `wrangler`.
- Migrations create the schema from §5.
- Seed `topics` table per §6.
- `GET /api/state` returns competence map (initially all zeros) and settings (initially defaults).
- Static-token auth middleware in place.
- Frontend reads state on load.

### Milestone 4: Hardcoded exercise loop
- Hand-write 2-3 hardcoded exercises in code (with prompt, starter, tests, reference solution).
- Wire `POST /api/exercise/next` to return one of them.
- User can write code, run it, see test results in the bottom strip.
- `POST /api/exercise/submit` records the attempt and updates competence (still no LLM).
- The full loop works end-to-end with hardcoded content. **This is the moment to confirm the loop feels good before adding LLM complexity.**

### Milestone 5: LLM examiner
- Wire OpenRouter from the Worker.
- `POST /api/exercise/submit` calls the examiner LLM, returns the review.
- Review displays in the chat pane.
- Verify the result-oriented behavior: write a deliberately ugly working solution, confirm the examiner passes it.

### Milestone 6: LLM generator
- `POST /api/exercise/next` generates fresh exercises when cache misses.
- Verify loop runs in browser (per §13 open question 2 — confirm with user first).
- Cache verified exercises in D1.

### Milestone 7: Helper chat + recall hotkey
- Chat pane fully functional.
- `Ctrl+K` recall popup.
- Auto-trigger on run errors (default on, configurable).

### Milestone 8: Difficulty progression
- Implement the unlock thresholds and difficulty mix per §7.
- Variety enforcement in the generator.

### Milestone 9: Settings + cost cap
- Settings page.
- Cost tracking + cap enforcement.

### Milestone 10: Stats page
- Surface the open question first; design with user; then build.

### Milestone 11: Idle-trigger "want a hint?"
- Final polish item. Implement after the rest of the loop is solid.

---

## 16. Notes for the implementing agent

- **When uncertain about a design choice, refer to §2 (core principles) first.** They were designed to override default instincts.
- **Open questions in §13 are real.** Surface them; don't silently decide.
- **Do not add features from §14.** If something tempting comes up, ask the user.
- **Keep the system prompts in `src/prompts/` as readable strings.** The user will want to tune them by hand.
- **Model IDs go through `src/config/models.ts`.** Never hardcode them in API call sites.
- **The verify loop is non-negotiable.** Never serve an unverified exercise to the user. A bad exercise is the worst-case UX failure.
- **The examiner system prompt is the most important prompt in the app.** Get it right; the result-oriented philosophy lives or dies here. Test it deliberately: submit ugly working code and confirm it passes without lecture.
