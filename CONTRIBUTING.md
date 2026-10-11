# Contributing

## 1. Every task is an issue

- Every task we find gets documented on GitHub as an issue. Do this **when the task
  is found**, not at the end of the session.
- Exception: when it is an obvious part of an open issue, update **that** issue
  (add it to its task list or a comment). If that issue is closed, open a new one
  and link back.

## 2. Large issues are split into sub-issues

- Each sub-issue explains, in its own body: scope, why, what it needs, and
  "done when".
- The **main issue** carries a table with exactly these headers, in this order:

  `Step | Issue | What it is | Needs | State`

  - **Step** — the sub-issue's placeholder name (see titles below).
  - **Issue** — the link, `#n`.
  - **What it is** — one or two sentences.
  - **Needs** — empty when it needs nothing; otherwise the issue(s) it depends on,
    as links (`#n`), not step names.
  - **State** — open / in progress (say what is left) / done, kept current as
    sub-issues move.

## 3. Pull requests close issues

- When a PR is attached to an issue and we are happy with it closing the issue,
  **we also close the issue** (do not rely on the keyword alone).
- Close it as completed with a comment naming the PR and what was verified.
  Anything not done yet is moved to another issue first (or the issue stays open
  with the remaining boxes).

## 4. Issue titles

Titles are `X{n} - Title (part of #issue)`:

- `X` is a letter fitting the main issue — this project uses **`M`** (MangaLibrary).
- The number is the position in the main issue's table (`M1`, `M2`, ...); a
  lowercase letter after the number marks a part of that step (`M1a`, `M1b`).
- The title ends with `(part of #n)` naming the main issue it belongs to.
- **Only a master issue (one with no parent) has no `M1` step and no suffix.**

## 5. Labels

Every issue gets labels when it is created (use the existing families — do not
create new ones without asking):

- `issue: main` (the issue has sub-issues) and `issue: sub` (it has a parent).
  An issue that is both has both.
- `area: server`, `area: ui`, `area: importer`, `area: infra`, `area: docs`,
  `area: scripts` — where the work happens.
- `type: feature`, `type: bug`, `type: chore`, `type: docs`, `type: testing`,
  `type: breaking`.
- `priority: high`, `priority: medium`, `priority: low`.
- `who: agent` (the agent can do it), `who: human` (needs the user: decisions,
  root, merges, accounts).

Never leave an issue without labels.

## 6. Ongoing rules

- **Tick boxes** in the parent **and** the sub-issue (`- [ ]` -> `- [x]`) in the
  same session as the work, and only what is verified. Say what is left open and why.
- **Review comments** (Copilot or human): after fixing one, reply on that thread
  with the commit hash, what changed, and the test added; if declined, say why.
  Verify each comment against the source before answering. Leave resolving the
  thread to the user.

## Branch & PR flow

- Work happens on a branch created from `main`, named `<issue#>-<slug>`, e.g.
  `5-komga-import-cli`.
- Open a PR referencing the issue. Merge with squash once quality gates pass.
- After merge, close the attached issue with a comment naming the PR.
