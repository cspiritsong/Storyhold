# Smart-Memory Single-Extension Contract

**Status:** E0 single-extension contract and writer kill-list
**Owner:** Bobby/default
**Source plan:** `/home/badi/.hermes/plans/2026-08-21_092551-smart-memory-extension-only.md`

## Goal

Keep maximum useful long-form roleplay recall in one installable SillyTavern extension
while sending one accurate, scoped, non-duplicated, token-bounded memory envelope to the
roleplay model.

The raw chat JSONL is the evidence layer. **Derived records never outrank the raw
transcript that produced them.** A narrative layer, state card, vector result, or profile
is a projection and must remain traceable to its source messages.

## Implementation boundary

This redesign is **solely a SillyTavern extension**. Smart-Memory is the only installed
memory extension and the only product runtime. All ingest, narrative layers, structured
projections, retrieval, reconciliation, ghosting, and prompt brokering live inside the
Smart-Memory extension and SillyTavern-supported storage: `chatMetadata`, small
`extension_settings` configuration, browser storage where appropriate, and optional native
Vector Storage APIs.

There is no sidecar service, separate database process, second required extension, or
SillyTavern core fork. Auxiliary model calls are initiated, serialized, bounded, and
fail-soft by the extension itself.

## Ownership

| Component | Owns | Product role |
|---|---|---|
| Smart-Memory host | The single extension runtime and event shell | Only installed memory product |
| Embedded narrative chain | Summaryception's absorbed recursive-layer algorithm under `chatMetadata.smartMemory.narrative` | Chronological narrative continuity |
| Smart-Memory structured projections | Facts, relationships, active arcs, epistemic/POV, current entity state | Current structured meaning |
| Native SillyTavern Vector Storage adapter | Optional semantic evidence lookup | Historical evidence only |
| Lorebook / World Info | Curated static world canon | Activated world rules/lore |
| Raw chat JSONL | Complete chronological evidence | Recovery and rebuild source |
| Memory broker | Scope, lineage, time, POV, deduplication, conflict resolution, budgets | The only combined prompt injection |

**Summaryception is an absorbed algorithm, not a required extension.** Its recursive
layering, seed promotion, narrative-delta prompts, and optional ghosting behavior may be
ported with AGPL attribution, but the separate Summaryception runtime, metadata key, and
prompt slot are not product dependencies.

The integrated product has **one prompt key**: `PROMPT_KEY_UNIFIED` /
`smart_memory_unified`. No `summaryception` prompt key is read or written on the product
path.

## Narrative chain

The embedded narrative chain stores:

- Layer 0 narrative deltas for bounded message windows;
- deeper layers promoted from older snippets;
- source message ranges and transcript fingerprints;
- a mesId-aware watermark;
- optional Smart-Memory-owned ghost flags that can be reversed;
- idempotent promotion and rebuild behavior.

The chain is the only automatic narrative writer. Smart-Memory compaction, automatic prose
canon, and scene-history prose are retired from the product path. Scene detection may remain
as a structured boundary signal; it must not create a second narrative injection block.

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

The product ingest path must be:

1. idempotent: replaying a committed window does not duplicate records;
2. resumable: a failed projection can retry without re-running successful projections;
3. source-ranged: every projection points back to the messages it used;
4. branch-aware: only a verified common prefix may be inherited;
5. quarantine-safe: an unverifiable branch produces no injectable derived records;
6. fail-soft: an extractor failure does not wipe good records or mix chats;
7. raw-preserving: the source transcript is never replaced by a derived summary;
8. single-runtime: every projection is owned by this extension, not a companion extension.

One ingest pass may fan out into multiple typed projections. It must not mean that several
independent runtimes each read the same window and establish separate watermarks.

## Writer and injector kill-list

| Current component | Existing behavior | Single-extension disposition |
|---|---|---|
| `index.js` | Orchestrates many independent extractors and injectors | E2 event shell and one queue drain |
| `compaction.js` | Progressive short-term prose summary and `PROMPT_KEY_SHORT` | Retire as writer; migrate old data only |
| `canon.js` | Generates/injects prose canon | No automatic writer; preserve only under explicit future policy |
| `scenes.js` | Detects breaks and injects prose scene history | Keep boundary/index logic; no prose history injection |
| `session.js` | Extracts chat-local details and injects a session tier | Keep structured projection; broker owns injection |
| `longterm.js` | Extracts facts/relationships and injects long-term tiers | Keep structured projection; broker owns injection |
| `arcs.js` | Extracts unresolved/resolved threads and injects arcs | Keep active-thread projection; broker owns injection |
| `state-ledger.js` | Extracts current entity state and injects state cards | Keep latest-state projection; broker owns injection |
| `epistemic.js` | Extracts knowledge, suspicions, false beliefs, and secrets | Keep POV projection; broker filters it |
| `profiles.js` | Generates compact snapshots and injects profiles | Keep only where it adds information beyond state cards |
| `summaryception-adapter.js` | Stamps snippets from a separate Summaryception slot | Migration-only; not a product runtime |
| `unified-inject.js` | Merges legacy slots | Delegate to the typed broker; never read a foreign slot |
| `continuity.js` | Checks contradictions and queues one-shot repair | Keep as validator/temporary repair input |

## Prompt contract

The final generation request has one Smart-Memory injection:

```text
PROMPT_KEY_UNIFIED = one broker envelope
```

The envelope is assembled in this order unless qualification evidence changes it:

1. compact stable identity/canon;
2. embedded recursive narrative history;
3. selected structured facts and relationships;
4. relevant historical evidence;
5. current state and active arcs;
6. responding-character epistemic constraints;
7. one-shot continuity repair, if valid.

The visible chat tail is not duplicated. Individual Smart-Memory slots are cleared before
or immediately after broker composition. A quarantined lineage yields an empty envelope.

## Isolation and lineage

- Per-character/per-chat scope is the default.
- A branch inherits only derived records and narrative layers wholly inside a verified common
  transcript prefix.
- Divergent-tail records never cross into the branch.
- MesId-less or unverifiable branches remain quarantined until explicit rebuild or evidence.
- Renames preserve stable `chat_uid` and narrative-layer provenance.
- Rebuild reads raw JSONL and recreates derived state; it does not trust stale projections.

## Acceptance tests for E0

- The contract identifies Smart-Memory as the sole extension host.
- Summaryception is described as an absorbed algorithm, not a required extension.
- Narrative storage is `chatMetadata.smartMemory.narrative`.
- There is one product prompt key and no foreign Summaryception slot dependency.
- Compaction, automatic canon prose, and scene-history prose are not product writers.
- A source window has one stable id and fingerprint.
- Every derived record has required provenance and time fields.
- An unverifiable branch has zero injectable derived records.
- Existing isolation, lineage, rename, rescan, deduplication, timeline, and budget tests remain
  green.

## Explicit non-goals

- No second installed memory extension.
- No sidecar, separate database process, or SillyTavern core fork.
- No VectFox revival and no vector purge.
- No automatic inheritance from an unverifiable branch.
- No automatic lorebook mutation in E0.
- No live Mac SillyTavern changes during local implementation.
- No claim of live qualification from local tests alone.
