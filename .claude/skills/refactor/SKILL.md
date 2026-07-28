---
name: refactor
description: Behaviour-preserving SOLID refactor of the branch's own changes in Mudbud, followed by a comment-hygiene pass and an ARCHITECTURE.md refresh. Use this whenever the user asks to refactor, restructure, clean up, tidy, "apply SOLID", split a file that got too big, pull duplication out, separate concerns, or generally improve the shape of code without changing what it does — including phrasings like "clean this up before I open the PR", "this module is doing too much", "sort out the structure of the branch", or "refactor the diff from main". Also use it when someone asks to bring the docs back in line after moving code around. Prefer this skill over ad-hoc editing even for a single file, because it carries the repo's gate commands, its existing seams, and the anti-goals that stop a refactor from turning into a rewrite.
---

# Refactor (Mudbud)

A refactor here is a trade: you spend risk to buy clarity. This skill exists to keep the
risk small and the clarity real — the code must do exactly what it did before, every gate
that was green stays green, and the structure afterwards is easier to extend than the
structure before.

Four things must be true when you are done:

1. **Behaviour is unchanged.** No new features, no fixed bugs, no changed output. If you
   spot a genuine bug mid-refactor, note it and leave it — mixing a fix into a
   restructuring hides both.
2. **The gates are at least as green as the baseline you recorded.**
3. **Comments were cleaned** with `.claude/hooks/comment-cleanup.sh` over the files you
   touched.
4. **`ARCHITECTURE.md` matches the code** if module boundaries moved.

## Step 0 — Compute the scope

Refactor what this branch changed, not the whole repo. Untouched code is someone else's
decision and carries no review context.

```bash
BASE=$(git merge-base main HEAD)
git diff --name-only "$BASE"...HEAD -- \
  'src/**' 'etl/glaze_etl/**' 'etl/tests/**' 'supabase/**' 'scripts/**' \
  ':!etl/tests/fixtures/**' ':!**/uv.lock' ':!package-lock.json' ':!assets/**'
```

If `main` has no shared history with `HEAD`, or the branch *is* `main`, fall back to the
tracked source tree and say so in your plan — an unbounded scope needs an explicit
decision, not a silent one.

Then measure before you commit to anything:

```bash
git diff --name-only "$BASE"...HEAD | wc -l
git ls-files 'src/**/*.ts*' 'etl/glaze_etl/**/*.py' | xargs wc -l | sort -rn | head -20
```

**Gate:** more than ~10 files or ~800 lines in play means you write a ranked plan first
and get it approved before editing. A refactor that touches everything at once cannot be
reviewed, and an unreviewable refactor is indistinguishable from a rewrite. If the user
has explicitly pre-authorised an unattended run, still write the plan — into the final
report — so the choices stay legible.

## Step 1 — Record the baseline

Run the gates *before* touching code. Without a recorded baseline, a red result afterwards
is uninterpretable — you cannot tell your refactor from a pre-existing failure.

Fast gates (run after every slice):

```bash
cd etl && uv run ruff check . && uv run mypy --strict glaze_etl && uv run pytest -q
npx tsc --noEmit
```

Slow gates (baseline once, then again before the final commit):

```bash
npx expo export --platform ios --output-dir /tmp/expo-export
for f in supabase/migrations/*.sql; do psql ... -f "$f"; done   # see .github/workflows/ci.yml
```

Do not reach for `npm run lint`. There is no ESLint config checked in, so `expo lint`
scaffolds one and installs dev dependencies on first run — a gate that edits `package.json`
is not a gate. `tsc` plus the bundle is the app's real check.

Two things to know about what the fast gates actually cover: the ETL integration tests
skip themselves without `TEST_SUPABASE_*` in the environment, so a green `pytest` locally
proves the pure stages (filename grammar, parser, colour naming, splitter) and nothing
about the database path. And `tsc --noEmit` type-checks the app but does not prove it
bundles — that is what `expo export` is for. Say which of these you actually ran when you
report; over-claiming coverage is worse than admitting the gap.

## Step 2 — SOLID, in this repo's idiom

SOLID is a diagnosis language, not a target architecture. Use it to name what hurts, then
apply the smallest change that removes the hurt.

**Single responsibility** — the live pressure in this repo. The largest modules do several
jobs at once: `etl/glaze_etl/core/loader.py`, `core/composite_splitter.py`, `core/media.py`
on the Python side; `src/app/glazes/[code].tsx` and `src/app/glazes/index.tsx` on the app
side, where data fetching, filter state and presentation share a file. The useful split is
by *reason to change* — a screen changes when the design changes, a query changes when the
schema changes, so those belong apart. Pulling a query into `src/db/repo.ts` or a
data-shaping helper into `src/lib/` beats inventing a new layer.

**Open/closed and dependency inversion** — mostly already solved, so respect the existing
seam rather than adding one. `core/source_adapter.py` is the abstraction the pipeline
depends on, and `sources/amaco/` is the implementation behind it; `core/pipeline.py`
sequences stages without knowing the manufacturer. When something manufacturer-specific
has leaked into `core/`, move it behind the adapter. That is a real DIP fix. Adding a
second abstraction next to `SourceAdapter` is not.

**Interface segregation and Liskov** — check that new `SourceAdapter` subclasses honour the
docstring contracts (`parse` is pure: no network, no clock, no database — `ReparseWorkflow`
depends on that), and that no consumer is forced to depend on methods it never calls.

### Anti-goals

These are the failure modes that make refactors net-negative, and each has bitten this kind
of codebase before:

- **No abstraction with a single implementation.** An interface with one implementor is
  indirection you pay for and never use.
- **No new dependencies.** `AGENTS.md` pins Expo SDK 54 + Expo Go; anything needing a dev
  client (React Native Skia, unsigned native modules) breaks the loop the project runs on.
  The ETL's dependency set is equally deliberate.
- **No editing applied migrations.** `supabase/migrations/*.sql` is append-only history. If
  the schema needs to change, that is a new migration and a new feature — out of scope here.
- **No file explosion.** Splitting a 125-line component into six files makes it harder to
  read, not easier. Split when a file has two reasons to change, not when it crosses a line
  count.
- **No renaming across the public surface** (CLI commands, exported hooks, RPC names, table
  or column names) unless you update every caller and the gates prove it.
- **No behaviour "improvements" smuggled in.** Better error messages, extra validation and
  performance tweaks are separate commits.

## Step 3 — Execute in slices

One concern per slice: one module split, or one duplication removed, or one dependency
inverted. After each slice, run the fast gates and commit. Small commits are what make a
behaviour-preserving claim checkable — a reviewer can read one and believe it.

Prefer mechanical moves over rewrites. Moving a function to a new module with its imports
adjusted is verifiable by eye; re-expressing its logic on the way is not, and the two
should never share a commit.

If a slice turns out to need behaviour changes to work, stop that slice and record it as
follow-up work. The scope of a refactor shrinks; it does not grow.

## Step 4 — Comment hygiene

Refactoring strands comments: they describe code that moved, or narrate steps that no
longer exist. Run the cleaner over exactly the files you touched:

```bash
.claude/hooks/comment-cleanup.sh $(git diff --name-only "$BASE"...HEAD)
```

It is delete-only — it spawns a subagent that may remove comment text and nothing else —
and it is biased toward keeping, because this repo's comments are unusually good: they
explain *why* (why bare postgres in CI, why prepared statements are off, why the coat order
lives in the pipeline). Losing those costs more than leaving a stale one. Review its diff
before committing; it is a tool, not an authority.

The same script is wired as a `PreToolUse` hook on `git commit` in `.claude/settings.json`,
where it cleans staged files and re-stages them. Calling it explicitly here means the
cleanup lands in the refactor's own commits with a visible diff rather than silently.

## Step 5 — Documentation

The doc structure is deliberately small: **`README.md`** for what the project is and how to
run it, **`ARCHITECTURE.md`** for how the pieces fit, **`AGENTS.md`** for the constraints
agents keep breaking. Do not add other top-level docs — a doc nobody is required to read
goes stale and then actively misleads.

`ARCHITECTURE.md` is one high-level Mermaid diagram plus a short legend. It answers "where
does this code live and what talks to what", at the level of modules and boundaries — never
individual functions, which change too often to keep true. Create it if missing; update it
when a refactor moves a boundary; leave it alone when nothing structural changed.

````markdown
# Architecture

```mermaid
graph TD
  ...
```

One short paragraph per box: what it owns, and what it must not know about.
````

Also check `README.md` for claims your refactor invalidated — commands, file paths named in
prose, the stack list. A path in the README that no longer exists is the cheapest kind of
lie to fix and the most annoying to hit.

## Step 6 — Verify and report

Rerun every gate, including the slow ones you baselined. Then read your own diff
(`git diff "$BASE"...HEAD --stat` plus the interesting hunks) as if reviewing someone else.

Report:

- What changed, grouped by concern, with the SOLID pressure each slice relieved.
- Gate results, before and after, naming which gates you actually ran.
- What you deliberately left alone and why — the ranked plan's tail, bugs you found and
  did not fix, follow-up work the scope rule pushed out.

A refactor report that lists only wins is not a report. The items you skipped are the ones
the reader needs most.
