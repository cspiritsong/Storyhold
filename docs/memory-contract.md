# Smart-Memory + Summaryception Memory Contract

**Status:** Phase 0 contract and writer audit
**Owner:** Bobby/default
**Source plan:** `/home/badi/.hermes/plans/2026-08-21_083521-smart-memory-architecture.md`

## Goal

Keep maximum useful recall in durable storage while sending one accurate, scoped,
non-duplicated, token-bounded memory envelope to the roleplay model.

The raw chat JSONL is the evidence layer. **Derived records never outrank the raw
transcript that produced them.** A summary, state card, vector result, or profile is a
projection and must remain traceable to its source messages.

## Ownership

| Owner | Owns | Prompt role |
|---|---|---|
| Smart-Memory | Structured facts, relationships, active arcs, epistemic/POV state, current entity state | Current structured state and selected facts |
| Summaryception | The single recursive chronological narrative chain | Compressed story history |
| Native SillyTavern Vector Storage | Optional semantic evidence retrieval | Specific historical evidence only |
| Lorebook / World Info | Curated static world canon | Activated world rules/lore |
| Raw chat JSONL | Complete chronological evidence | Visible history and recovery source |
| Memory broker (Phase 2) | Scope, lineage, time, POV, deduplication, conflict resolution, budgets | The only combined memory injection |

**Summaryception is the single narrative writer.** Smart-Memory `compaction.js` and
`canon.js` are not allowed to create competing automatic narrative histories once the
unified pipeline is enabled. Scene records may remain as structured boundary/index data,
but a second prose scene-history block must not be injected.

**Compaction is retired as an automatic narrative writer** for the integrated path. Its
old stored summaries remain migration evidence until explicitly rebuilt or retired; P1
must not silently delete them.

## Derived-record contract

Every new derived record must include:

- `id`: stable record identifier;
- `kind`: typed projection such as `fact`, `state`, `relationship`, `arc`, `epistemic`,
  or `narrative_delta`;
- `scope.chat_uid`: stable chat identity;
- `scope.branch_uid`: branch/lineage identity when available;
- `source_range`: canonical source message range, preferring `mesId` and retaining an
  index fallback for imported chats;
- `story_time`: when the event occurs in the fiction, which may be unknown;
- `knowledge_time`: when the character/system learned or recorded it;
- `validity`: active, superseded, uncertain, or invalid, with validity bounds;
- `confidence`: numeric value from 0 through 1;
- `provenance`: source chat, source messages, and extraction/projection origin;
- `supersedes` or `superseded_by`: explicit replacement relationship where applicable.

Do not invent an exact story date when the transcript does not provide one. Keep story
time, knowledge time, and conversation position separate.

## Ingest contract

An ingest window is identified by:

```text
stable chat_uid + branch_uid + source range + transcript fingerprint
```

The ingest path must be:

1. idempotent: replaying a committed window does not duplicate records;
2. resumable: a failed projection can retry without re-running successful projections;
3. source-ranged: every projection points back to the messages it used;
4. branch-aware: only a verified common prefix may be inherited;
5. quarantine-safe: an unverifiable branch produces no injectable derived records;
6. fail-soft: an extractor failure does not wipe good records or mix chats;
7. raw-preserving: the source transcript is never replaced by a derived summary.

One ingest pass may fan out into multiple typed projections. It must not mean that
five independent writers each read the same window and establish their own watermarks.

## Writer and injector audit — current `main`

| Component | Current behavior | Integrated disposition |
|---|---|---|
| `index.js` | Orchestrates compaction, scene detection, session extraction, long-term extraction, arcs, state, profiles, epistemic work, and separate injections | P1 queue coordinator; remove independent writer sequencing |
| `compaction.js` | Progressive short-term narrative summary and `PROMPT_KEY_SHORT` injection | Retire as automatic narrative writer; preserve old data for migration/evidence |
| `canon.js` | Generates and injects a prose canon document | No automatic competing narrative writer; consume only through an explicit approved canon policy |
| `scenes.js` | Detects scene breaks, records scene history, and injects scene history | Keep boundary detection and structured index; no second prose history injection |
| `session.js` | Extracts chat-local details and injects a session tier | Keep as Smart-Memory structured projection; broker owns final injection |
| `longterm.js` | Extracts facts/relationships, consolidates, and injects long-term/triggered tiers | Keep storage and reconciliation; broker owns final injection |
| `arcs.js` | Extracts unresolved/resolved narrative threads and injects arcs | Keep active-thread projection; broker owns final injection |
| `state-ledger.js` | Extracts current entity state and injects the state block | Keep latest-state projection; broker owns final injection |
| `epistemic.js` | Extracts character knowledge, suspicions, false beliefs, and secrets | Keep POV projection; broker filters by responding character |
| `profiles.js` | Generates compact character/world/relationship snapshots and injects profiles | Keep only as a compact projection; avoid duplicating State Ledger fields |
| `unified-inject.js` | Concatenates cached tier slots in fixed order and clears individual slots | Evolve into/hand off to the Phase 2 broker; it is not yet conflict-aware |
| `continuity.js` | Checks contradictions and may queue a one-shot repair note | Keep as validator/repair input, never as permanent truth |
| Summaryception reference | Owns recursive layered narrative snippets and ghosting | Adapter target; no Smart-Memory fact extraction from its snippets |
| Native ST Vector Storage | Separate optional retrieval/index subsystem | Evidence backend only; never Smart-Memory authoritative state |

## Injection contract

Phase 1 may continue to expose legacy individual slots for compatibility, but the
integrated mode must declare one active narrative writer and one final memory envelope.
Phase 2 must make the following invariant testable:

```text
broker_on ⇒ exactly one memory envelope is injectable
```

The envelope must be assembled in this order unless a later qualification result changes
it:

1. compact stable canon/identity;
2. deep Summaryception narrative history;
3. selected Smart-Memory facts and relationships;
4. visible recent chat history;
5. retrieved historical evidence, only when relevant;
6. current State Ledger and active arcs near the active turn;
7. responding-character epistemic constraints;
8. one-shot continuity repair, if valid;
9. final generation instructions.

No section may repeat content already present in the visible chat tail. A quarantined
lineage yields an empty memory envelope until the branch is verified or explicitly
rebuilt.

## Acceptance tests for Phase 0

- A source window has one stable id and fingerprint.
- Every derived record has the required provenance and time fields.
- All records from a window carry the same chat and branch scope.
- Ownership declares Summaryception as the single narrative writer.
- Compaction and automatic canon are not active narrative writers in integrated mode.
- A quarantined branch has zero injectable derived records.
- Existing isolation, lineage, rename, rescan, deduplication, timeline, and budget tests
  remain green.

## Explicit non-goals

- No new summarizer, tracker, or MemoryBooks/charSummaryception stack.
- No VectFox revival and no vector purge.
- No live Mac SillyTavern changes during local implementation.
- No automatic inheritance from an unverifiable branch.
- No automatic lorebook mutation in Phase 0.
- No claim of live qualification from local tests alone.
