# SITREP: Smart-Memory (Storyhold)
> **Status:** Active
> **Last updated:** 2026-09-16

### 1. 📍 The Origin (Where we started & why)
Forked from senjinthedragon's Smart Memory to become **Storyhold**, a chat-local narrative-memory extension for SillyTavern that keeps long roleplay coherent without the user administering memory like a mod list.

### 2. 🏁 The Destination (Where we want to go / what "done" looks like)
One installable, set-and-play SillyTavern extension that owns ingest, narrative layers, structured projection, retrieval, reconciliation, admission, and prompt brokering — with a domain-neutral core timeline and no sidecar service, external DB, or second memory extension.

### 3. 🚩 Ground Won (Locked down & verified)
- [x] Storyhold 1.16.0 released (chore: release commit on `main`).
- [x] Operating contract written in `AGENTS.md`: product boundary, installable-extension-only rule, Summaryception absorbed not depended on, native Vector Storage explicitly not canonical.
- [x] Architecture reference exists at `docs/memory-contract.md` (ownership, projection, ingest, prompt, lineage, admission, non-goals).
- [x] Core implementation surface present: `compaction.js`, `continuity.js`, `canon.js`, `arcs.js`, `branch-aware.js` / `branch-detection.js` / `branch-ops.js`, `admission-policy.js`, `budget-policy.js`, `dedup-audit.js`, `embedding-providers.js`, `chat-memory-manager.js`.
- [x] Group-chat support shipped: per-character memory stores, selector panel, independent profiles/entity registry per member.
- [x] Two qualification rigs landed 2026-09-01: headless product-pipeline rig and disposable SillyTavern browser smoke rig (S2).
- [x] Public shipping lane `cspiritsong/Storyhold`; local "Smart-Memory" naming is fork-only.

### 4. 🗺️ The Route Ahead (How we get there)
- [ ] Clear the dirty working tree — triage, split, and commit the in-flight test/pipeline changes on `main`.
- [ ] Run the headless qualification rig plus the S2 browser smoke rig end-to-end and record the evidence under `.hermes/`.
- [ ] Reconcile code against `docs/memory-contract.md` where they disagree (contract wins or gets amended), then prep the next release into `CHANGELOG.md`.

---
### ⚡ As of Right Now...
- **State:** Dirty tree on `main`; HEAD is test-rig work (`test: add disposable SillyTavern browser smoke rig (S2)`) sitting on top of the 1.16.0 release commit.
- **Blocker:** None — but uncommitted changes mean the qualification run is not reproducible from a known commit.
- **👉 Next Move:** `git status` + diff review, then commit or stash the smoke-rig changes so the two 2026-09-01 rigs run against a clean `main`.
