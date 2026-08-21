/**
 * Single memory-envelope broker.
 *
 * This module is pure and owns presentation only: it combines typed records,
 * filters duplicates/superseded records, marks unresolved conflicts, applies a
 * total token budget, and returns one injectable block. It does not mutate
 * Smart-Memory chat storage.
 */

import {
  estimateTokens,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_CANON,
  PROMPT_KEY_EPISTEMIC,
  PROMPT_KEY_LONG,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_REPAIR,
  PROMPT_KEY_RELATIONSHIPS,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_STATE_LEDGER,
  PROMPT_KEY_TRIGGERED,
  PROMPT_KEY_UNIFIED,
} from './constants.js';
import { assembleNarrative } from './narrative-chain.js';
import { filterRetrievalRecords, retrieveDeterministic, retrieveWithLadder } from './retrieval.js';

export const BROKER_SLOT_SECTIONS = Object.freeze([
  { key: PROMPT_KEY_CANON, section: 'narrative' },
  { key: PROMPT_KEY_SHORT, section: 'narrative' },
  { key: PROMPT_KEY_SCENES, section: 'narrative' },
  { key: PROMPT_KEY_LONG, section: 'facts' },
  { key: PROMPT_KEY_RELATIONSHIPS, section: 'facts' },
  { key: PROMPT_KEY_SESSION, section: 'evidence' },
  { key: PROMPT_KEY_PROFILES, section: 'state' },
  { key: PROMPT_KEY_STATE_LEDGER, section: 'state' },
  { key: PROMPT_KEY_ARCS, section: 'arcs' },
  { key: PROMPT_KEY_EPISTEMIC, section: 'epistemic' },
]);

/** Converts legacy prompt-slot strings into broker section records. */
export function buildSectionsFromSlots(slotValues = {}) {
  const sections = Object.fromEntries(BROKER_SECTION_ORDER.map((name) => [name, []]));
  for (const { key, section } of BROKER_SLOT_SECTIONS) {
    const content = String(slotValues[key] ?? '').trim();
    if (!content) continue;
    sections[section].push({
      id: key,
      kind: 'legacy_slot',
      content,
      scope: { chat_uid: 'legacy-slot' },
    });
  }
  return sections;
}

/** Builds broker sections from the embedded Smart-Memory typed narrative state. */
export function buildSectionsFromTypedState({
  narrativeState = null,
  chatUid = null,
  branchUid = null,
} = {}) {
  const sections = Object.fromEntries(BROKER_SECTION_ORDER.map((name) => [name, []]));
  const narrative = narrativeState ? assembleNarrative(narrativeState) : '';
  if (narrative) {
    const resolvedChatUid = chatUid ?? narrativeState?.chat_uid ?? 'smart-memory-narrative';
    const resolvedBranchUid = branchUid ?? narrativeState?.branch_uid ?? null;
    const scope = { chat_uid: resolvedChatUid };
    if (resolvedBranchUid != null) scope.branch_uid = resolvedBranchUid;
    sections.narrative.push({
      id: 'smart_memory_narrative_chain',
      kind: 'narrative_delta',
      content: narrative,
      scope,
    });
  }
  return sections;
}


export const BROKER_INJECTION_KEY = PROMPT_KEY_UNIFIED;
export const BROKER_SECTION_ORDER = Object.freeze([
  'narrative',
  'facts',
  'evidence',
  'state',
  'arcs',
  'epistemic',
]);

const SECTION_LABELS = Object.freeze({
  narrative: 'NARRATIVE',
  facts: 'FACTS',
  evidence: 'EVIDENCE',
  state: 'CURRENT STATE',
  arcs: 'ACTIVE THREADS',
  epistemic: 'KNOWLEDGE / POV',
});

const SECTION_PRIORITY = Object.freeze({
  state: 100,
  arcs: 90,
  epistemic: 85,
  narrative: 80,
  facts: 60,
  evidence: 40,
});

const ALL_INDIVIDUAL_SLOTS = Object.freeze([
  ...BROKER_SLOT_SECTIONS.map(({ key }) => key),
  PROMPT_KEY_TRIGGERED,
  PROMPT_KEY_REPAIR,
]);

function normalizedContent(record) {
  return String(record?.content ?? record?.text ?? record?.summary ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function inferredSection(record) {
  if (BROKER_SECTION_ORDER.includes(record?.section)) return record.section;
  switch (record?.kind) {
    case 'narrative_delta':
    case 'summary':
      return 'narrative';
    case 'state':
    case 'profile':
      return 'state';
    case 'arc':
      return 'arcs';
    case 'epistemic':
      return 'epistemic';
    default:
      return 'facts';
  }
}

function recordSourceId(record) {
  return record?.id ?? record?.provenance?.id ?? null;
}

function isActiveRecord(record) {
  return !record?.superseded_by && !['invalid', 'superseded'].includes(record?.validity?.status);
}

function deduplicateRecords(records, trace) {
  const seen = new Map();
  const output = [];
  for (const item of records) {
    const content = normalizedContent(item.record);
    if (!content) {
      if (recordSourceId(item.record)) trace.dropped_ids.push(recordSourceId(item.record));
      continue;
    }
    if (!isActiveRecord(item.record)) {
      if (recordSourceId(item.record)) trace.dropped_ids.push(recordSourceId(item.record));
      continue;
    }
    if (seen.has(content)) {
      if (recordSourceId(item.record)) trace.dropped_ids.push(recordSourceId(item.record));
      continue;
    }
    seen.set(content, item);
    output.push(item);
  }
  return output;
}

function conflictGroupKey(record) {
  if (record?.conflict_key) return String(record.conflict_key);
  if (Array.isArray(record?.contradicts) && record.contradicts.length > 0) {
    return [...record.contradicts].sort().join('|');
  }
  return null;
}

function resolveConflicts(items, trace) {
  const groups = new Map();
  for (const item of items) {
    const key = conflictGroupKey(item.record);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const replacements = new Map();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const distinct = new Set(group.map(({ record }) => normalizedContent(record)));
    if (distinct.size < 2) continue;
    const winner = [...group].sort(
      (a, b) => Number(b.record?.confidence ?? 0) - Number(a.record?.confidence ?? 0),
    )[0];
    replacements.set(key, {
      ...winner,
      record: {
        ...winner.record,
        _broker_uncertain: true,
        _broker_conflict_count: group.length,
      },
    });
    trace.conflicts.push({
      key,
      candidate_ids: group.map(({ record }) => recordSourceId(record)).filter(Boolean),
      selected_id: recordSourceId(winner.record),
    });
    for (const item of group) {
      if (item !== winner && recordSourceId(item.record)) trace.dropped_ids.push(recordSourceId(item.record));
    }
  }

  const output = [];
  const replaced = new Set();
  for (const item of items) {
    const key = conflictGroupKey(item.record);
    if (key && replacements.has(key)) {
      if (replaced.has(key)) continue;
      replaced.add(key);
      output.push(replacements.get(key));
    } else {
      output.push(item);
    }
  }
  return output;
}

function formatRecord(record) {
  const prefix = record?._broker_uncertain ? '[uncertain] ' : '';
  const content = String(record?.content ?? record?.text ?? record?.summary ?? '').trim();
  return `- ${prefix}${content}`;
}

function buildSections(items) {
  const sections = Object.fromEntries(BROKER_SECTION_ORDER.map((name) => [name, []]));
  for (const item of items) {
    const section = inferredSection(item.record);
    sections[section].push(item);
  }
  return sections;
}

function renderItems(items) {
  const sections = buildSections(items);
  const blocks = [];
  for (const section of BROKER_SECTION_ORDER) {
    const sectionItems = sections[section];
    if (!sectionItems || sectionItems.length === 0) continue;
    blocks.push(
      `${SECTION_LABELS[section]}:\n${sectionItems
        .map(({ record }) => formatRecord(record))
        .join('\n')}`,
    );
  }
  if (blocks.length === 0) return { text: '', ids: [], sections };
  const ids = items.map(({ record }) => recordSourceId(record)).filter(Boolean);
  if (ids.length > 0) blocks.push(`SOURCE IDS: ${ids.join(', ')}`);
  return { text: blocks.join('\n\n'), ids, sections };
}

function truncateSingleSelection(item, totalBudget) {
  const original = String(item.record?.content ?? '');
  if (estimateTokens(renderItems([item]).text) <= totalBudget) return [item];

  let low = 0;
  let high = original.length;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const suffix = middle < original.length ? '…' : '';
    const candidate = {
      ...item,
      record: {
        ...item.record,
        content: `${original.slice(0, middle).trimEnd()}${suffix}`.trim(),
      },
    };
    if (estimateTokens(renderItems([candidate]).text) <= totalBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ? [best] : [];
}

function fitSelectionToBudget(selected, totalBudget, trace) {
  const fitted = [...selected];
  while (fitted.length > 1 && estimateTokens(renderItems(fitted).text) > totalBudget) {
    let removeIndex = 0;
    for (let index = 1; index < fitted.length; index++) {
      if (fitted[index].priority < fitted[removeIndex].priority) removeIndex = index;
    }
    const [removed] = fitted.splice(removeIndex, 1);
    if (recordSourceId(removed.record)) trace.dropped_ids.push(recordSourceId(removed.record));
  }
  if (fitted.length === 1) return truncateSingleSelection(fitted[0], totalBudget);
  return fitted;
}

function selectWithinBudget(sections, totalBudget, trace) {
  const all = [];
  for (const section of BROKER_SECTION_ORDER) {
    for (const item of sections[section]) {
      all.push({
        ...item,
        section,
        priority: SECTION_PRIORITY[section],
      });
    }
  }

  // Prefer current state and active threads, but restore the canonical section
  // order when rendering below. This prevents a large fact pool from starving
  // the information most likely to matter for the next response.
  all.sort(
    (a, b) =>
      b.priority - a.priority ||
      Number(b.record?.confidence ?? 0) - Number(a.record?.confidence ?? 0),
  );

  const selected = [];
  for (const item of all) {
    const trial = [...selected, item];
    if (selected.length === 0 || estimateTokens(renderItems(trial).text) <= totalBudget) {
      selected.push(item);
    } else if (recordSourceId(item.record)) {
      trace.dropped_ids.push(recordSourceId(item.record));
    }
  }

  const fitted = fitSelectionToBudget(selected, totalBudget, trace);
  const rendered = renderItems(fitted);
  return {
    selectedSections: rendered.sections,
    selected: fitted,
    contentTokens: estimateTokens(rendered.text),
  };
}

function renderEnvelope(_selectedSections, selected, trace) {
  const rendered = renderItems(selected);
  trace.selected_ids = rendered.ids;
  return rendered.text;
}

function emptyResult(reason = 'no-candidates') {
  return {
    text: '',
    tokens: 0,
    selected_ids: [],
    dropped_ids: [],
    injected_slots: [],
    injectable_slots: [],
    suppressed_slots: [],
    reason,
    trace: { conflicts: [], retrieval: null },
  };
}

/**
 * Finalizes already-collected records synchronously. Used by the existing
 * unified-inject path so prompt-slot updates cannot race a generation.
 */
function finalizeEnvelope({ baseItems, totalBudget, trace }) {
  if (baseItems.length === 0) return { ...emptyResult('no-candidates'), trace };
  const deduplicated = deduplicateRecords(baseItems, trace);
  const resolved = resolveConflicts(deduplicated, trace);
  const grouped = buildSections(resolved);
  const { selectedSections, selected, contentTokens } = selectWithinBudget(
    grouped,
    Math.max(1, Number(totalBudget) || 1),
    trace,
  );
  const text = renderEnvelope(selectedSections, selected, trace);
  if (!text) return { ...emptyResult('budget-empty'), trace };

  return {
    text,
    tokens: estimateTokens(text),
    selected_ids: trace.selected_ids,
    dropped_ids: [...new Set(trace.dropped_ids)],
    injected_slots: [BROKER_INJECTION_KEY],
    injectable_slots: [BROKER_INJECTION_KEY],
    suppressed_slots: [...ALL_INDIVIDUAL_SLOTS],
    reason: null,
    trace: { ...trace, content_tokens: contentTokens },
  };
}

function sectionItems(sections) {
  const items = [];
  for (const section of BROKER_SECTION_ORDER) {
    for (const record of Array.isArray(sections?.[section]) ? sections[section] : []) {
      items.push({ record: { ...record, section }, source: 'section' });
    }
  }
  return items;
}

/**
 * Synchronous section/record composition for prompt paths that already have
 * their candidates. Query-driven vector escalation belongs to the async API.
 */
export function buildMemoryEnvelopeSync({
  chatUid,
  branchUid = null,
  respondingCharacter = null,
  povMode = 'allow-secondhand',
  lineage = null,
  query = '',
  records = [],
  sections = {},
  totalBudget = 1200,
} = {}) {
  if (lineage?.quarantined) return emptyResult('lineage-quarantined');
  const trace = { conflicts: [], retrieval: null, selected_ids: [], dropped_ids: [] };
  const baseItems = sectionItems(sections);
  const hasQuery = (typeof query === 'string' ? query : query?.text ?? '').trim().length > 0;
  if (hasQuery) {
    const retrieval = retrieveDeterministic({
      records,
      query,
      chatUid,
      branchUid,
      respondingCharacter,
      povMode,
      lineage,
    });
    trace.retrieval = retrieval;
    for (const record of retrieval.candidates) {
      baseItems.push({ record: { ...record, section: record.section ?? 'evidence' }, source: 'retrieval' });
    }
  } else {
    const eligible = filterRetrievalRecords(records, {
      chatUid,
      branchUid,
      respondingCharacter,
      povMode,
      lineage,
    });
    for (const record of eligible) baseItems.push({ record, source: 'record' });
  }
  return finalizeEnvelope({ baseItems, totalBudget, trace });
}

/**
 * Builds one final memory envelope from typed sections and optional retrieval
 * callbacks. This function never writes to SillyTavern prompt slots.
 */
export async function buildMemoryEnvelope({
  chatUid,
  branchUid = null,
  respondingCharacter = null,
  povMode = 'allow-secondhand',
  lineage = null,
  query = '',
  records = [],
  sections = {},
  totalBudget = 1200,
  vectorSearch = null,
  agenticSearch = null,
  allowVector = true,
  allowAgentic = false,
} = {}) {
  if (lineage?.quarantined) return emptyResult('lineage-quarantined');

  const trace = { conflicts: [], retrieval: null, selected_ids: [], dropped_ids: [] };
  const baseItems = sectionItems(sections);
  const hasQuery = (typeof query === 'string' ? query : query?.text ?? '').trim().length > 0;
  if (Array.isArray(records) && records.length > 0) {
    if (hasQuery) {
      const retrieval = await retrieveWithLadder({
        records,
        query,
        chatUid,
        branchUid,
        respondingCharacter,
        povMode,
        lineage,
        vectorSearch,
        agenticSearch,
        allowVector,
        allowAgentic,
      });
      trace.retrieval = retrieval;
      for (const record of retrieval.candidates) {
        baseItems.push({ record: { ...record, section: record.section ?? 'evidence' }, source: 'retrieval' });
      }
    } else {
      const eligible = filterRetrievalRecords(records, {
        chatUid,
        branchUid,
        respondingCharacter,
        povMode,
        lineage,
      });
      for (const record of eligible) baseItems.push({ record, source: 'record' });
    }
  }

  return finalizeEnvelope({ baseItems, totalBudget, trace });
}

/** Creates a broker with optional vector/agentic callbacks and a small cache. */
export function createMemoryBroker({
  vectorSearch = null,
  agenticSearch = null,
  allowVector = true,
  allowAgentic = false,
  cache = new Map(),
} = {}) {
  return {
    async compose(input = {}) {
      const queryText = typeof input.query === 'string' ? input.query : input.query?.text ?? '';
      const tip = input.chatTipFingerprint ?? '';
      const key = `${input.chatUid ?? ''}|${input.branchUid ?? ''}|${tip}|${queryText}`;
      if (tip && cache.has(key)) return { ...cache.get(key), trace: { ...cache.get(key).trace, cache_hit: true } };
      const result = await buildMemoryEnvelope({
        ...input,
        vectorSearch: input.vectorSearch ?? vectorSearch,
        agenticSearch: input.agenticSearch ?? agenticSearch,
        allowVector: input.allowVector ?? allowVector,
        allowAgentic: input.allowAgentic ?? allowAgentic,
      });
      if (tip) cache.set(key, result);
      return result;
    },
    clearCache() {
      cache.clear();
    },
  };
}
