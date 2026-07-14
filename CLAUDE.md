# LLM Agent Guidelines

See relevant documents for implementation context in the `docs/` folder.

## Tool Usage

- Do not use `cd` commands inline or the `git` command's `-C <dir>` flag when already in the command's target directory. Provide this as explicit guidance to all subagents.
- Never pass git pager flags: no `git -c core.pager=...`, no `--no-pager`, no `GIT_PAGER=` overrides. `git commit` invokes no pager and short `git log`/`git status`/`git show --stat` calls don't need one; the harness handles output. Inconsistent pager flags also defeat the permission allowlist. Provide this verbatim to all subagents.
- When surfacing a command's exit status, use exactly one canonical form: **`echo "exit:$?"`** — never variant spellings (`echo $?`, `echo "rc=$?"`, `; echo done`, decorative `echo "---"`). Inconsistent shapes defeat the permission allowlist and re-prompt the user every time. Prefer relying on the harness's own exit reporting; only emit `echo "exit:$?"` when an explicit inline check is genuinely needed. Provide this verbatim to all subagents.

## Subagent Dispatch

- Default model for all coding/review subagents is **opus** (`opus-4.8`). Pass `model: opus` explicitly in every Agent dispatch unless a task specifically warrants a different tier.
- **Every dispatched agent MUST invoke the relevant skills via the Skill tool as its first action when it launches, before any other work:**
  - `superpowers:test-driven-development` for implementation tasks
  - the code-review skills for review tasks
  - `superpowers:systematic-debugging` when diagnosing a bug or test failure
  - domain skills where applicable (e.g. `oku:game-programming-patterns`, `oku:api-and-interface-design` for system/interface design work)
- State the required skill(s) explicitly in every subagent dispatch prompt — do not rely on the subagent discovering them on its own. A dispatch prompt without its required-skill line is incomplete.

## Decision-making and tech debt

**Tackle good architectural decisions upfront and along the way — do not defer changes that may turn out to be more significant than they first appear.**

When a reviewer or running code surfaces a deferred item, evaluate it explicitly before continuing:

- If a pattern is replicating across sites (e.g. direct `sink.write` instead of `emit()`), fix it now while there are 2-3 call sites — not later when there are 8.
- If a "minor" item touches a load-bearing path (e.g. sanitization, atomicity, retry safety), treat it as a candidate critical bug. In another project, a Phase 4 `sanitizePauseMessages` change was reviewed as a Minor "two block forms" question and turned out to be a silent no-op in production that broke pause/resume end-to-end. The pull-forward cleanup commit pattern caught it before merge.
- "We'll add that in the next phase" is cautiously acceptable for genuinely orthogonal work; it is not acceptable for changes that are cheap now and grow expensive linearly with new code.
- When deferring, audit the inventory at task boundaries (between subagent dispatches) so the cumulative debt stays visible — not buried in scattered review notes.

This applies to architectural choices, port shapes, dependency direction, error-handling paths, and observability. The cost of pausing to fix something now is almost always less than the cost of debugging it under a real failure.

## Increment Workflow

Work proceeds in numbered **increments**. Durable, cross-increment context (product vision, architecture, the design system) lives in `docs/overview.md`; increment specs reference it instead of duplicating it.

Each increment lives in `docs/increment-<N>-<slug>/` with three files:

- `design.md` — the design/spec from brainstorming (what & why, scope, architecture touchpoints, UX, acceptance criteria).
- `plan.md` — the implementation plan from writing-plans (phased TDD tasks).
- `impl.md` — running implementation notes: decisions, deviations from plan, deferred debt, review findings, verification evidence. Updated **during and after** the increment.

Per-increment flow:

1. **Brainstorm** → `design.md` (`superpowers:brainstorming`).
2. **Write plan** → `plan.md` (`superpowers:writing-plans`).
3. **Plan-review gate (before any code):** dispatch **parallel** review subagents to critique `plan.md` against `design.md`, `docs/overview.md`, and these conventions — at minimum (a) an **architecture/DDD** reviewer (port shapes, dependency DAG, interface segregation, lazy init, fail-fast config) and (b) a **plan-quality / test-strategy** reviewer (phasing, TDD coverage, minimum-optimal tests, acceptance criteria). Address findings; revise the plan before executing.
4. **Execute** on a feature branch `feat/ffl-<N>-<slug>`, TDD per task. **During implementation**, after each task/phase dispatch **parallel** reviews: (a) **spec-conformance** (does the code match `design.md`/`plan.md`?) and (b) **code-quality** (the Review checklist below, clean architecture). Fix HIGH/MEDIUM before continuing.
5. **Self-verify:** build, test, and lint all pass.
6. **Final holistic review:** one comprehensive pass over the whole increment against `design.md`, `plan.md`, `docs/overview.md`, and these conventions (dependency DAG, segregated interfaces, error/observability paths, tests = minimum-optimal & contract-focused). Address findings.
7. **PR + merge** per the Implementation process below. Record outcomes and any deferred items in `impl.md`.

All dispatched review/implementation subagents must invoke their required skills (see Subagent Dispatch) and apply the Testing Methodology — state the required skill explicitly in every dispatch.

## Implementation process

When implementing a feature with an agent:

1. **Implement** on a feature branch (`feat/ffl-N-short-slug`)
2. **Self-verify:** build, test, and lint must all pass before committing
3. **Push** and create a PR via `gh pr create --fill`
4. **Review:** run code review and domain review (DDD / clean architecture) together in a subagent before merging
5. **Fix findings:** address all HIGH and MEDIUM findings, commit on the same branch, push
6. **Re-verify:** build, test, and lint again after fixes
7. **Merge** via `gh pr merge --merge --delete-branch`, then `git checkout main && git pull`

Use the `gh` CLI for all PR operations — never merge locally with `git merge` unless instructed otherwise.
Never squash-merge — preserve full commit history.

**Review checklist:**

- No `as any` casts
- Interfaces are segregated (not fat)
- Dependencies flow inward, are onion-layered, and form a valid DAG per domain-driven design
- Lazy init preferred over eager module-scope singletons
- Required config keys fail fast, not silently default to empty string
- Tests use in-memory sources, not real env vars
- Use effective defaults where applicable
- Core operations emit a canonical wide structured event (see Observability); no ad-hoc unstructured logging on load-bearing paths

## Testing Methodology

Tests exist to verify the capabilities and contracts **we** own — not the language, libraries, or framework, and not how a thing happens to be wired internally.

- **Test our capabilities, not pre-existing functionality.** Do not write tests that assert behavior owned by the stdlib or a third-party library (e.g. that `typeid` is K-sortable, that `encoding/json` round-trips). Assume dependencies work; test the behavior our code adds on top.
- **Minimum optimal set.** Write the fewest tests that fully cover the capabilities and contracts we want guaranteed. More tests is not better — redundant or trivially-derived tests are maintenance liability, not safety. Each test should fail for a distinct, meaningful reason.
- **Test behavior through interfaces, not implementation details.** Target the functional logic flow and the interface that functionality depends on (a single function or a larger unit). Do not couple tests to private structure, field layout, call order, or incidental representation that will churn every time the internals are touched. If a refactor that preserves behavior breaks the test, the test was testing the wrong thing.
- **Unit vs integration.** Unit tests verify one unit's behavioral contract in isolation. Integration tests verify logic flows **across** systems/boundaries produce the expected end-to-end results — they are where cross-system correctness is proven, not duplicated per-unit.
- **End-to-end / UX tests (Playwright).** For user-facing flows and visuals that unit tests cannot reach — especially behavior behind `onMount`, two-way `bind:` on form controls (`<select>`), and rendered visual state — write Playwright scripts that drive the real frontend in a browser with the Go/Wails bindings stubbed, with screenshot/visual checks where useful. The jsdom unit harness provably cannot exercise these paths; E2E is where logic-flow and visual correctness are validated. Keep E2E to the minimum-optimal set of meaningful flows; don't re-assert unit-covered logic.
- **Required-skill usage.** All implementation and review agents (including dispatched subagents) MUST invoke the relevant superpowers coding skills for the work — `superpowers:test-driven-development` for implementation, the code-review skills for review — and apply this testing methodology within them. State the required skill explicitly in every subagent dispatch.

Add to the Review checklist above: tests are the minimum optimal set, assert our contracts (not dependencies), and are decoupled from implementation detail.

## Observability

Adopt **observability 2.0 — canonical wide structured events** (Honeycomb/Stripe "canonical log line" style):

- Emit **one arbitrarily-wide event per meaningful operation** (a use-case call, a request, a sync action) rather than scattered narrow log lines. Accumulate context onto a single event as the operation proceeds, then emit it once at completion (success or failure) with outcome, duration, identifiers, and relevant fields.
- Events are **structured JSON written to `jsonl`** (one event per line) so they're trivially greppable/queryable and can later ship to a backend (Honeycomb, etc.). Prefer high-cardinality fields (ids, versions, counts) over free-text messages.
- Emit through an **injected emitter port** — no global logger, no `fmt.Println`/ad-hoc `log` on core paths — so the sink is swappable and tests can assert emitted events. Application services and the Wails/UI boundary are the natural emit points.
- Cross-cutting foundation: establish the emitter port + jsonl sink early (next increment) and emit canonical events from every new operation thereafter.

## General Conventions

- Use lower-case brief comments where necessary, except for docstrings
- Reuse existing design system components and style variables (e.g. primary/secondary colors)
- Keep view styles consistent with the design system (typography, colors, spacing)

## Commit Messages

- Use `type(root_folder:component): message` format for commit messages
  - e.g. `feat(desktop:coord): add ECI and LVLH frame types`
  - `docs: message` or similar broad types are acceptable for cross-cutting changes
- Keep commit messages concise and impactful, including the related work item ID if given
- Focus on "what" and "why", not implementation details
- Do not include any Co-Authored-By attributions
