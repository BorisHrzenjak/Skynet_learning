# TODO

## High priority

- [ ] Add automated tests for the worker endpoints.
- [ ] Add automated frontend smoke/integration tests for the core learning loop.
- [ ] Add tests for generation and verification edge cases.
- [ ] Do a final design-doc compliance review against `app_design.md`.

## Settings and cost tracking

- [ ] Add a settings toggle for run-error auto-explain.
- [ ] Improve validation and error messaging for invalid model ids and bad threshold values.
- [ ] Improve UI messaging when cost caps block helper, generator, examiner, or recall calls.
- [ ] Consider showing spend by LLM role, not just daily/monthly totals.
- [ ] Consider surfacing the active manual pricing config in the UI.

## Exercise generation hardening

- [ ] Improve deduplication against recently seen exercise shapes.
- [ ] Strengthen generation validation before browser verification.
- [ ] Improve retry and fallback heuristics when a model returns unusable output.
- [ ] Improve prompt quality by topic and difficulty band.
- [ ] Continue tuning generated prompt clarity and consistency.

## Prompt and prompt-system visibility

- [ ] Expose system prompts in the app so they are inspectable without opening source files.
- [ ] Add a simple prompt-inspection UI for generator, examiner, helper, and recall roles.

## Stats and reporting polish

- [ ] Add sorting and filtering to the stats page.
- [ ] Group stats by difficulty band more clearly.
- [ ] Add trend indicators or simple progress deltas.
- [ ] Add deeper per-topic detail views.

## UX polish

- [ ] Improve cached-vs-generated loading feedback even further.
- [ ] Improve empty, loading, and failure states across the app.
- [ ] Improve narrow-window behavior even if desktop remains the main target.
- [ ] Review chat, recall, and prompt interactions for small usability issues.

## Structural and optional items

- [ ] Decide whether settings should stay a modal or become a dedicated page.
- [ ] Decide whether per-exercise chat history should persist.
- [ ] Decide whether prompt inspection should live in settings, stats, or a dedicated debug view.

## Definition of "solid"

- [ ] Automated tests exist for the main flows.
- [ ] Settings and cost-cap UX are clear.
- [ ] Prompts are inspectable in-app.
- [ ] Remaining spec gaps from `app_design.md` are either implemented or consciously deferred.
