# Storyhold / Smart-Memory — local operating contract

This file is the compact routing and safety contract for work in this repository.
It is not a replacement for the detailed product contract, active plan, or release
history. Read the relevant source before making assumptions.

## Mission and project identity

- `/home/badi/projects/Smart-Memory` is the development repository for **Storyhold**,
  a chat-local narrative-memory extension for SillyTavern.
- The public shipping lane is `cspiritsong/Storyhold`; “Smart-Memory” is the local
  repository/fork name.
- The product goal is **set-and-play**: ordinary roleplay should not feel like
  maintaining a Skyrim mod list. Badi should not need to administer memory during a
  normal chat.
- User-facing defaults may lean toward D&D/campaign play, but the core timeline and
  memory contract must remain domain-neutral enough for a later variant toggle.

## Canonical project documents

- `docs/memory-contract.md` — detailed ownership, projection, ingest, prompt, lineage,
  admission, and non-goal contract. Treat it as the architecture reference; if code
  and the document disagree, inspect and reconcile rather than guessing.
- `README.md` — user-facing installation and behavior documentation.
- `CHANGELOG.md` — release history; do not put release-specific facts in this file.
- `package.json` — package identity and verification scripts.
- `.gitignore` — repository boundary for generated, local, and sensitive artifacts.
- Active plans and temporary execution evidence belong under `.hermes/`; do not treat
  their card IDs, test counts, version numbers, or temporary statuses as durable rules.

## Product boundary

- Storyhold is **solely one installable SillyTavern extension**. Do not modify the
  SillyTavern core, add a sidecar service, require an external database process, or
  rely on a second installed memory extension.
- All ingest, narrative layers, structured projections, retrieval, reconciliation,
  admission, and prompt brokering belong to this extension and SillyTavern-supported
  storage.
- Summaryception's useful recursive narrative algorithm is absorbed inside Storyhold;
  Summaryception itself is not a runtime dependency, metadata owner, or prompt writer.
- Native SillyTavern Vector Storage is a separate optional semantic-evidence system.
  Storyhold must not silently merge, purge, delete, or synchronize it as if it were
  Storyhold's canonical memory.

## What “HOLD” means

- The raw SillyTavern chat JSONL is the evidence and recovery source. Derived memory
  never outranks or replaces the transcript.
- One bounded, idempotent, resumable Product ingest path may produce several typed
  projections, but independent runtimes must not process the same window or establish
  competing watermarks.
- The recursive narrative chain holds **what happened** across recent scene deltas
  and deeper history, retaining source ranges and transcript fingerprints.
- The timeline/event ledger holds **when**, keeping conversation position, story time,
  knowledge time, and validity separate. Preserve unknown dates; never invent an exact
  story date from insufficient text. Backstory, flashback, hypothetical, rumor, and
  current events must not be conflated.
- Structured Product records hold current meaning: facts, relationships, state, arcs,
  session evidence, and epistemic/perspective information.
- Embeddings are derived retrieval/deduplication evidence, not human-editable memory
  and not a second source of truth.
- Model output is candidate input, not a checklist or truth oracle. Admission must be
  conservative about empty, repeated, unchanged, narrative-only, duplicate, and
  over-cap candidates while preserving provenance, scope, validity, and confidence.
- The memory broker owns the single combined prompt envelope. Product mode must not
  restore competing legacy prompt writers or separate per-tier injection blocks.

## Ownership and isolation

- Each chat owns an independent Storyhold tree identified by stable `chat_uid`.
- `main_chat` and parent metadata are navigation/provenance only; they do not grant
  automatic parent-memory inheritance or character-wide shared mutable memory.
- Cross-file or branch inheritance is allowed only for a verified common transcript
  prefix with matching identity, branch evidence, source range, and fingerprint.
  Divergent-tail records never cross into the new branch.
- Missing or unverifiable identity/lineage quarantines derived data and produces no
  injectable Product memory. Rebuild reads the current raw transcript instead of
  trusting stale projections.
- Renames preserve stable identity and provenance. Retrieval, injection, Query,
  Challenge, UI, rebuild, rescan, and deletion must all enforce current-chat scope.

## Default user flow

```text
chat event or clearly named scan
    → bounded current-chat ingest window
    → timeline + narrative + structured projections
    → visible Product status
    → one broker-owned prompt envelope and current-chat UI
```

- Normal play should work without opening advanced memory settings or understanding
  namespaces, branches, cursors, projections, retention, or vector providers.
- `Memorize Chat`/automatic catch-up must visibly report meaningful progress and a
  terminal result. A successful write hidden behind an empty or legacy UI is a bug.
- Product UI reads scoped canonical Product stores. Legacy compatibility controls may
  remain only where explicitly supported; they must not race or duplicate Product
  processing.
- Query and Challenge are read-only, current-chat-scoped, evidence-based operations.
  They must distinguish supported, contradicted, unresolved, blocked, and unavailable
  outcomes without mutating memory or inventing evidence.
- The Memory Explorer/editor is optional progressive disclosure. It may expose records,
  timeline interpretations, provenance, and safe corrections, but it must not become a
  mandatory maintenance dashboard.

## Safety and currentness invariants

- Every asynchronous operation captures chat ID, stable UID, metadata identity,
  generation, and relevant responder before its first `await`; recheck them before
  every mutation, save, injection, or repaint.
- Chat switches, swipes, edits, deletes, and regenerations invalidate stale work,
  clear stale prompt/UI/macro state, and prevent late results from reaching another
  chat.
- Disabled, Fresh Start, read-only, quarantined, cancelled, missing-identity, and
  invalidated states fail closed. They must not write derived memory or inject stale
  records.
- Rescan, rebuild, reset, retire, and delete operations are current-chat scoped and
  must state their exact destructive boundary. Derived edits never pretend to correct
  the raw transcript.
- Branch pruning and cursor advancement must account for deletions, sparse or
  mesId-less ranges, fingerprints, no-progress windows, retries, and partial versus
  capped versus finished outcomes.
- Reservations, listeners, queues, and busy controls must be released or restored on
  success, failure, cancellation, invalidation, quarantine, mismatch, and handoff.
- Before any destructive live qualification, use a Badi-approved disposable chat and
  preserve the raw-chat recovery path. Preserve raw JSONL, character cards, other
  chats, unrelated metadata, and native Vector Storage.

## Development and routing loop

- Bobby/default is the sole coding executor for this repository. Implement directly
  with Hermes editing and verification tools; do not route implementation through
  Codex, Claude Code, CodeGuy, or the retired `codeguy-handoffs` path.
- Use the smallest useful **Look → Plan → Do → Check** loop. Inspect the actual tree,
  trace symbols and call paths, state the acceptance check, then act.
- For behavior changes, use focused TDD: regression test red for the expected reason,
  smallest safe fix, focused green run, affected suites, then the full gate.
- Keep shared source edits, migrations, and UI mutation work serial. Parallelize only
  genuinely independent read-only work, and place an evidence/checker gate before
  synthesis or release decisions.
- Freeze source changes before the consolidated release gate. Do not dispatch a broad
  reviewer while source is still moving. A reviewer report is evidence to inspect, not
  proof by itself.
- For interruption-prone multi-stage qualification, use the dedicated Storyhold
  workstream board `storyhold-qualification-and-explorer`, not a retired board. Keep
  active plans and current card state there or under `.hermes/plans/`; do not put
  temporary progress in this file.
- When blocked, stop broad implementation: separate observed facts from assumptions,
  preserve the exact failure, run the smallest distinguishing test, and report the
  blocker honestly. If a gate becomes stale after later edits, rerun it.

## Publishing and installation boundary

- **Bobby uploads/publishes to GitHub only. Badi installs and tests on the Mac.** Do
  not install, update, reload, or modify the Mac's SillyTavern instance unless Badi
  explicitly authorizes that specific action.
- A local source/package gate or successful push is not live qualification. Read back
  the remote identity/version after publishing; live Mac evidence is separate.
- **Never rewrite published Git history** on this repo (no force-push, filter-branch,
  or rebase-and-push) once any commit has been pulled by an installed copy. For
  authorship or identity corrections, add a new commit.

## GitHub identity lane

- This repo ships under **cspiritsong** (`cspiritsong <cspiritsong@users.noreply.github.com>`).
  Do not commit or push as `badiyee85`.
- Use the `GITHUB_CSPIRITSONG_TOKEN` credential route for cspiritsong-owned pushes;
  never let the active `badiyee85` credential push to this repository. Keep token
  values out of chat, memory, remotes, command arguments, and files.

## Verification and finish line

Before reporting a source or documentation change as done, run the relevant real
checks. For a normal repository change, the gate is:

```bash
npm test
npx --no-install eslint .
node --check <changed-runtime-files>
npx --no-install markdownlint-cli2 README.md CHANGELOG.md AGENTS.md
npm run package:extension
git diff --check
```

Also inspect package closure/installability, manifest/package version consistency,
changed-file scope, and the absence of secrets, chat contents, or accidental native
Vector Storage dependencies. Use actual totals and output from the current run; never
reuse stale counts from an earlier session.

Report status at the evidence level earned:

- **Prepared** — plan, contract, or handoff exists.
- **Observed** — a command, tool, or system recorded an action/result.
- **Verified** — the named acceptance check passed.

Do not call a plan complete, a command start deployed, a push live, or an unverified
agent/reviewer claim a passing release.

## Privacy, hygiene, and maintenance

- Never commit credentials, provider payloads, raw chat contents, private screenshots,
  local databases, or secret-bearing logs. Represent encountered secrets as
  `[REDACTED]`.
- Keep generated output, dependencies, environment files, OS artifacts, and local
  planning/evidence within the `.gitignore` boundary. Do not publish `.hermes/`
  working evidence unless it is intentionally authored as a public project artifact.
- Update this file when a workflow rule or architectural invariant is confirmed and
  will improve future work. Do not encode guesses, one-off outcomes, temporary TODOs,
  active card IDs, commit hashes, release numbers, or old test counts here.
- When a newly learned rule belongs in a detailed product or user document instead,
  update that canonical document and add only the routing pointer here.
