/**
 * Read model for the optional current-chat Product Memory Explorer.
 *
 * This module is deliberately independent of SillyTavern and the DOM. It
 * filters ownership, applies timeline overrides, and produces stable sorted
 * data for the UI and tests.
 */

import { applyTimelineOverrides } from './product-mutations.js';

const PRODUCT_KINDS = Object.freeze([
  'fact',
  'event',
  'relationship',
  'session',
  'state',
  'arc',
  'epistemic',
]);

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalized(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result === '' ? null : result;
}

function requiredChatUid(value) {
  const result = normalized(value);
  if (!result) throw new TypeError('chatUid is required');
  return result;
}

function recordChatValues(record) {
  return [
    record?.scope?.chat_uid,
    record?.scope?.source_chat_uid,
    record?.scope?._source_chat_uid,
    record?.chat_uid,
    record?.source_chat_uid,
    record?.provenance?.chat_uid,
    record?.provenance?.source_chat_uid,
  ]
    .map(normalized)
    .filter(Boolean);
}

function belongsToChat(record, chatUid) {
  const values = recordChatValues(record);
  return values.length > 0 && values.every((value) => value === chatUid);
}

function normalizedRange(range) {
  if (Array.isArray(range) && range.length >= 2) {
    const start = Number(range[0]);
    const end = Number(range[1]);
    return Number.isInteger(start) && Number.isInteger(end) && end >= start
      ? { kind: 'index', start, end }
      : null;
  }
  if (!range || typeof range !== 'object') return null;
  const start = Number(range.start);
  const end = Number(range.end);
  return Number.isInteger(start) && Number.isInteger(end) && end >= start
    ? { kind: range.kind ?? 'index', start, end }
    : null;
}

function sourceStart(record) {
  const range = normalizedRange(record?.source_range ?? record?.sourceRange);
  return Number.isInteger(range?.start) ? range.start : Number.MAX_SAFE_INTEGER;
}

function timelineStart(event) {
  if (Number.isInteger(event?.conversation_index)) return event.conversation_index;
  const range = normalizedRange(event?.source_message_range ?? event?.source_range);
  return Number.isInteger(range?.start) ? range.start : Number.MAX_SAFE_INTEGER;
}

function sourcePreview(range, chat) {
  const normalizedRangeValue = normalizedRange(range);
  if (!normalizedRangeValue || !Array.isArray(chat)) return 'source preview unavailable';
  const messages = normalizedRangeValue.kind === 'mesId'
    ? chat.filter((message) => {
        const mesId = Number(message?.mesId);
        return Number.isInteger(mesId)
          && mesId >= normalizedRangeValue.start
          && mesId <= normalizedRangeValue.end;
      })
    : chat.slice(normalizedRangeValue.start, normalizedRangeValue.end + 1);
  const preview = messages
    .map((message) => {
      const name = normalized(message?.name);
      const text = String(message?.mes ?? '').replace(/\s+/g, ' ').trim();
      return name ? `${name}: ${text}` : text;
    })
    .filter(Boolean)
    .join(' ');
  return preview ? preview.slice(0, 360) : 'source preview unavailable';
}

function isActive(record) {
  return !record?.superseded_by && !['invalid', 'superseded'].includes(record?.validity?.status);
}

function recordStatus(record) {
  if (record?.superseded_by || record?.validity?.status === 'superseded') return 'superseded';
  if (record?.validity?.status === 'invalid') return 'retired';
  return record?.validity?.status ?? 'active';
}

function matchesStatus(record, status) {
  if (!status || status === 'all') return true;
  return recordStatus(record) === status;
}

/** Returns only current-chat records matching the optional Explorer filters. */
export function filterExplorerRecords(
  records,
  { chatUid = null, kind = 'all', status = 'active', search = '', entity = '', includeInactive = false } = {},
) {
  const expectedChatUid = requiredChatUid(chatUid ?? '');
  const expectedKind = normalized(kind)?.toLowerCase() ?? 'all';
  const expectedStatus = normalized(status)?.toLowerCase() ?? 'active';
  const expectedSearch = normalized(search)?.toLowerCase() ?? '';
  const expectedEntity = normalized(entity)?.toLowerCase() ?? '';
  return list(records)
    .filter((record) => belongsToChat(record, expectedChatUid))
    .filter((record) => expectedKind === 'all' || normalized(record?.kind)?.toLowerCase() === expectedKind)
    .filter((record) => includeInactive || isActive(record))
    .filter((record) => matchesStatus(record, expectedStatus))
    .filter((record) => {
      if (!expectedSearch) return true;
      return String(record?.content ?? '').toLowerCase().includes(expectedSearch);
    })
    .filter((record) => {
      if (!expectedEntity) return true;
      const values = [record?.entity, record?.subject, record?.target, ...(record?.entity_names ?? [])]
        .map(normalized)
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      return values.includes(expectedEntity);
    })
    .map(clone)
    .sort((left, right) => sourceStart(left) - sourceStart(right) || String(left.id).localeCompare(String(right.id)));
}

function buildCounts(records) {
  const counts = {};
  for (const kind of PRODUCT_KINDS) counts[kind] = 0;
  for (const record of records) {
    if (Object.prototype.hasOwnProperty.call(counts, record?.kind)) counts[record.kind]++;
  }
  return counts;
}

function buildTimeline(timeline, timelineOverrides, chat = [], chatUid) {
  const source = timeline && typeof timeline === 'object' ? timeline : {};
  const events = applyTimelineOverrides(list(source.events), timelineOverrides, { chatUid })
    .map((event) => ({
      ...event,
      source_preview: sourcePreview(event.source_message_range ?? event.source_range, chat),
    }))
    .sort((left, right) => timelineStart(left) - timelineStart(right)
      || String(left.event_id ?? '').localeCompare(String(right.event_id ?? '')));
  return {
    ...clone(source),
    events,
    conflicts: list(source.conflicts).map(clone),
    totalEvents: events.length,
  };
}

function buildNarrative(narrative) {
  const source = narrative && typeof narrative === 'object' ? narrative : {};
  const layers = list(source.layers).map((layer) => list(layer).map(clone));
  return {
    state: clone(source),
    layers,
    layerCount: layers.length,
    snippets: layers.reduce((total, layer) => total + layer.length, 0),
  };
}

function eventRange(event) {
  const range = normalizedRange(event?.source_message_range ?? event?.source_range);
  if (range) return range;
  const index = Number(event?.conversation_index);
  return Number.isInteger(index) ? { kind: 'index', start: index, end: index } : null;
}

function recordRange(record) {
  const range = normalizedRange(record?.source_range ?? record?.sourceRange);
  if (range) return range;
  const messages = record?.provenance?.source_messages;
  if (Array.isArray(messages) && messages.length > 0 && messages.every((value) => Number.isInteger(value))) {
    return { kind: 'mesId', start: Math.min(...messages), end: Math.max(...messages) };
  }
  return null;
}

/**
 * Read-only provenance note for citations that ingest-time grounding found
 * outside their source window. The record stays trusted for its content; the
 * note simply keeps the Explorer honest about which citations could not be
 * verified. Returns null when there is nothing to warn about.
 */
export function unverifiedCitationNote(record) {
  const raw = record?.provenance?.citation_unverified;
  if (!Array.isArray(raw)) return null;
  const values = raw.filter((value) => Number.isInteger(value));
  if (values.length === 0) return null;
  return `citation outside window: ${values.join(', ')}`;
}

function snippetRange(snippet) {
  if (Array.isArray(snippet?.source_ranges) && snippet.source_ranges.length > 0) {
    return normalizedRange(snippet.source_ranges[0]);
  }
  return normalizedRange(snippet?.source_range ?? snippet?.sourceRange);
}

function overlaps(left, right) {
  if (!left || !right) return false;
  const kindsMatch = left.kind === right.kind;
  if (kindsMatch) return left.start <= right.end && right.start <= left.end;
  // A timeline event also carries a conversation index, so an index range can
  // still overlap a mesId range; no story ordering is invented here.
  return false;
}

/**
 * Builds a domain-neutral chronological spine over the current chat.
 *
 * This is a read model only: it projects timeline events, structured records,
 * and narrative snippets into a stable top-to-bottom order without changing
 * any stored data. The latest event sits at the bottom; the current story
 * clock (when known) is marked explicitly.
 */
export function buildTimelineSpine(timelineModel, records, narrativeModel) {
  const events = list(timelineModel?.events).map(clone);
  const recordList = list(records).map(clone);
  const layers = list(narrativeModel?.layers).map((layer) => list(layer).map(clone));

  const assignedRecordIds = new Set();
  const assignedSnippetIds = new Set();
  const nodes = [];

  for (const event of events) {
    const range = eventRange(event);
    const related = recordList.filter((record) => {
      if (assignedRecordIds.has(String(record.id))) return false;
      if (!overlaps(range, recordRange(record))) return false;
      assignedRecordIds.add(String(record.id));
      return true;
    });
    const narrative = layers.flat().filter((snippet) => {
      if (assignedSnippetIds.has(String(snippet.id))) return false;
      if (!overlaps(range, snippetRange(snippet))) return false;
      assignedSnippetIds.add(String(snippet.id));
      return true;
    });
    nodes.push({
      event_id: event.event_id,
      story_time: event.story_time ?? null,
      knowledge_time: event.knowledge_time ?? null,
      narrative_role: event.narrative_role ?? 'current',
      conversation_index: Number.isInteger(event.conversation_index) ? event.conversation_index : null,
      source_range: range,
      source_preview: event.source_preview ?? '',
      conflicts: event.contradicts?.length > 0 || event.temporal_relations?.length > 0,
      related,
      narrative,
    });
  }

  // Records and snippets without a matching timeline event still belong to the
  // spine; they are grouped by their own source position as unattached nodes.
  const unattachedRecords = recordList.filter((record) => !assignedRecordIds.has(String(record.id)));
  const unattachedNarrative = layers.flat().filter((snippet) => !assignedSnippetIds.has(String(snippet.id)));
  if (unattachedRecords.length > 0 || unattachedNarrative.length > 0) {
    nodes.push({
      event_id: null,
      story_time: null,
      knowledge_time: null,
      narrative_role: 'unresolved',
      conversation_index: null,
      source_range: null,
      source_preview: '',
      conflicts: false,
      related: unattachedRecords,
      narrative: unattachedNarrative,
    });
  }

  const lastCurrent = nodes.findLastIndex((node) => node.narrative_role === 'current');
  return {
    nodes,
    totalNodes: nodes.length,
    currentIndex: lastCurrent >= 0 ? lastCurrent : 0,
    hasUnresolved: unattachedRecords.length > 0 || unattachedNarrative.length > 0,
  };
}

/** Builds the complete current-chat Explorer view model. */
export function buildProductExplorerModel({
  chatUid,
  chatId = null,
  records = [],
  timeline = null,
  timelineOverrides = [],
  chat = [],
  narrative = null,
  narrativeStale = false,
} = {}) {
  const expectedChatUid = requiredChatUid(chatUid);
  const currentRecords = filterExplorerRecords(records, {
    chatUid: expectedChatUid,
    status: 'all',
    includeInactive: true,
  });
  const timelineModel = buildTimeline(timeline, timelineOverrides, chat, expectedChatUid);
  const narrativeModel = buildNarrative(narrative);
  return {
    chatUid: expectedChatUid,
    chatId: normalized(chatId),
    records: currentRecords,
    activeRecords: currentRecords.filter(isActive),
    counts: buildCounts(currentRecords),
    timeline: timelineModel,
    spine: buildTimelineSpine(timelineModel, currentRecords, narrativeModel),
    narrative: {
      ...narrativeModel,
      stale: Boolean(narrativeStale),
    },
  };
}

export function renderProductExplorer(container, model, {
  view = 'records',
  kind = 'all',
  status = 'active',
  search = '',
  includeInactive = false,
  onChange = null,
} = {}) {
  if (!container) return;
  container.replaceChildren();
  const root = document.createElement('div');
  root.className = 'sm-product-explorer-inner';

  const heading = document.createElement('div');
  heading.className = 'sm-product-explorer-heading';
  const title = document.createElement('strong');
  title.textContent = 'Chat Memory Explorer';
  const identity = document.createElement('span');
  identity.className = 'sm-muted';
  identity.textContent = `Current chat only · ${model.chatId ?? model.chatUid}`;
  heading.append(title, identity);
  root.append(heading);

  const tabs = document.createElement('div');
  tabs.className = 'sm-product-explorer-tabs';
  for (const [value, label] of [['records', 'Records'], ['timeline', 'Timeline'], ['narrative', 'Narrative']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button${view === value ? ' is-active' : ''}`;
    button.dataset.explorerView = value;
    button.textContent = label;
    button.addEventListener('click', () => onChange?.({ view: value, kind, status, search, includeInactive }));
    tabs.append(button);
  }
  root.append(tabs);

  if (view === 'records') {
    const filters = document.createElement('div');
    filters.className = 'sm-product-explorer-filters';
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'menu_button';
    addButton.dataset.explorerAction = 'add-record';
    addButton.dataset.explorerKind = kind === 'all' ? 'fact' : kind;
    addButton.textContent = 'Add memory';
    filters.append(addButton);
    const scanButton = document.createElement('button');
    scanButton.type = 'button';
    scanButton.className = 'menu_button';
    scanButton.dataset.explorerAction = 'scan-recent';
    scanButton.dataset.explorerKind = kind;
    scanButton.textContent = kind === 'all' ? 'Scan recent' : `Scan recent ${kind}`;
    filters.append(scanButton);
    const kindSelect = document.createElement('select');
    kindSelect.className = 'text_pole';
    kindSelect.setAttribute('aria-label', 'Filter memory type');
    for (const option of ['all', ...PRODUCT_KINDS]) {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = option === 'all' ? 'All types' : option;
      item.selected = option === kind;
      kindSelect.append(item);
    }
    kindSelect.addEventListener('change', () => onChange?.({ view, kind: kindSelect.value, status, search, includeInactive }));

    const statusSelect = document.createElement('select');
    statusSelect.className = 'text_pole';
    statusSelect.setAttribute('aria-label', 'Filter memory status');
    for (const option of ['active', 'uncertain', 'retired', 'superseded', 'all']) {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = option === 'all' ? 'All statuses' : option;
      item.selected = option === status;
      statusSelect.append(item);
    }
    statusSelect.addEventListener('change', () => onChange?.({ view, kind, status: statusSelect.value, search, includeInactive }));

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'text_pole';
    searchInput.placeholder = 'Search this chat\'s memory';
    searchInput.setAttribute('aria-label', 'Search this chat memory');
    searchInput.value = search;
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(
        () => onChange?.({ view, kind, status, search: searchInput.value, includeInactive }),
        150,
      );
    });

    const retiredLabel = document.createElement('label');
    retiredLabel.className = 'checkbox_label sm-product-explorer-retired-toggle';
    const retiredInput = document.createElement('input');
    retiredInput.type = 'checkbox';
    retiredInput.checked = includeInactive;
    retiredInput.addEventListener('change', () => onChange?.({ view, kind, status, search, includeInactive: retiredInput.checked }));
    retiredLabel.append(retiredInput, document.createTextNode(' Show retired/history'));
    filters.append(kindSelect, statusSelect, searchInput, retiredLabel);
    root.append(filters);

    const records = filterExplorerRecords(model.records, {
      chatUid: model.chatUid,
      kind,
      status,
      search,
      includeInactive: includeInactive || status !== 'active',
    });
    const summary = document.createElement('div');
    summary.className = 'sm-muted sm-product-explorer-summary';
    summary.textContent = `${records.length} matching record${records.length === 1 ? '' : 's'} · ${model.activeRecords.length} active in this chat`;
    root.append(summary);
    const listElement = document.createElement('div');
    listElement.className = 'sm-product-explorer-list';
    if (records.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sm-product-empty';
      empty.textContent = 'No matching Product records in this chat.';
      listElement.append(empty);
    }
    for (const record of records) {
      const row = document.createElement('div');
      row.className = 'sm-product-explorer-record';
      row.dataset.recordId = record.id;
      const body = document.createElement('div');
      body.className = 'sm-product-explorer-record-body';
      const meta = document.createElement('div');
      meta.className = 'sm-product-explorer-record-meta';
      const type = document.createElement('span');
      type.className = 'sm_memory_type';
      type.textContent = record.kind;
      const state = document.createElement('span');
      state.className = `sm-memory-status sm-memory-status-${recordStatus(record)}`;
      state.textContent = recordStatus(record);
      meta.append(type, state);
      if (record.manual_override?.active) {
        const manual = document.createElement('span');
        manual.className = 'sm-memory-status sm-memory-status-manual';
        manual.textContent = 'manual';
        meta.append(manual);
      }
      const content = document.createElement('div');
      content.className = 'sm-product-explorer-record-content';
      content.textContent = String(record.content ?? '');
      const source = document.createElement('div');
      source.className = 'sm-muted sm-product-explorer-source';
      const range = normalizedRange(record.source_range ?? record.sourceRange);
      source.textContent = formatSourceRange(range);
      const citationNote = unverifiedCitationNote(record);
      if (citationNote) {
        const warning = document.createElement('span');
        warning.className = 'sm-memory-status sm-memory-status-uncertain';
        warning.textContent = citationNote;
        source.append(' ', warning);
      }
      body.append(meta, content, source);
      const actions = document.createElement('div');
      actions.className = 'sm-product-explorer-record-actions';
      if (range && Number.isInteger(range.start) && Number.isInteger(range.end)) {
        const sourceButton = document.createElement('button');
        sourceButton.type = 'button';
        sourceButton.className = 'menu_button';
        sourceButton.dataset.explorerAction = 'jump-source';
        sourceButton.dataset.sourceStart = String(range.start);
        sourceButton.dataset.sourceEnd = String(range.end);
        sourceButton.dataset.sourceKind = range.kind ?? 'index';
        sourceButton.textContent = 'Source';
        actions.append(sourceButton);
      }
      for (const [action, label] of recordStatus(record) === 'retired'
        ? [['restore-record', 'Restore'], ['delete-record', 'Delete']]
        : [['edit-record', 'Edit'], ['retire-record', 'Retire'], ['delete-record', 'Delete']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button';
        button.dataset.explorerAction = action;
        button.dataset.recordId = record.id;
        button.textContent = label;
        actions.append(button);
      }
      row.append(body, actions);
      listElement.append(row);
    }
    root.append(listElement);
  } else if (view === 'timeline') {
    const summary = document.createElement('div');
    summary.className = 'sm-muted sm-product-explorer-summary';
    summary.textContent = `${model.timeline.totalEvents} event${model.timeline.totalEvents === 1 ? '' : 's'} in this chat · ${model.timeline.conflicts.length} conflict${model.timeline.conflicts.length === 1 ? '' : 's'}`;
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'menu_button';
    refreshButton.dataset.explorerAction = 'refresh-timeline';
    refreshButton.textContent = 'Refresh timeline';
    summary.append(' ', refreshButton);
    root.append(summary);
    const spineElement = document.createElement('div');
    spineElement.className = 'sm-product-explorer-spine';
    const spine = model.spine ?? { nodes: [], currentIndex: 0, hasUnresolved: false };
    if (spine.nodes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sm-product-empty';
      empty.textContent = 'No timeline events have been derived from this chat yet.';
      spineElement.append(empty);
    }
    spine.nodes.forEach((node, index) => {
      const marker = document.createElement('div');
      marker.className = 'sm-product-spine-node';
      marker.dataset.spineRole = node.narrative_role ?? 'current';
      if (index === spine.currentIndex) marker.dataset.spineNow = 'true';

      const stem = document.createElement('div');
      stem.className = 'sm-product-spine-stem';
      const dot = document.createElement('span');
      dot.className = 'sm-product-spine-dot';
      stem.append(dot);
      marker.append(stem);

      const card = document.createElement('div');
      card.className = 'sm-product-spine-card';

      const head = document.createElement('div');
      head.className = 'sm-product-spine-head';
      const when = document.createElement('span');
      when.className = 'sm-product-spine-when';
      when.textContent = node.narrative_role === 'unresolved' ? 'Unresolved chronology' : formatStoryTime(node.story_time);
      const role = document.createElement('span');
      role.className = 'sm-memory-status';
      role.textContent = node.narrative_role ?? 'current';
      const badges = document.createElement('span');
      badges.className = 'sm-product-spine-badges';
      if (index === spine.currentIndex) {
        const now = document.createElement('span');
        now.className = 'sm-product-spine-now';
        now.textContent = 'NOW';
        badges.append(now);
      }
      if (node.conflicts) {
        const conflict = document.createElement('span');
        conflict.className = 'sm-product-spine-conflict';
        conflict.textContent = 'uncertain';
        badges.append(conflict);
      }
      head.append(when, role, badges);
      card.append(head);

      if (node.source_preview) {
        const preview = document.createElement('div');
        preview.className = 'sm-product-spine-preview';
        preview.textContent = node.source_preview;
        card.append(preview);
      }

      const links = [...(node.related ?? []), ...(node.narrative ?? [])];
      if (links.length > 0) {
        const details = document.createElement('details');
        details.className = 'sm-product-spine-links';
        const toggle = document.createElement('summary');
        toggle.textContent = `${links.length} linked ${links.length === 1 ? 'detail' : 'details'}`;
        details.append(toggle);
        for (const link of links) {
          const item = document.createElement('div');
          item.className = 'sm-product-spine-link';
          item.dataset.linkKind = link.kind ?? 'narrative';
          item.textContent = String(link.content ?? link.text ?? '').replace(/\s+/g, ' ').trim();
          details.append(item);
        }
        card.append(details);
      }

      const actions = document.createElement('div');
      actions.className = 'sm-product-explorer-record-actions';
      const range = node.source_range;
      if (range && Number.isInteger(range.start) && Number.isInteger(range.end)) {
        const sourceButton = document.createElement('button');
        sourceButton.type = 'button';
        sourceButton.className = 'menu_button';
        sourceButton.dataset.explorerAction = 'jump-source';
        sourceButton.dataset.sourceStart = String(range.start);
        sourceButton.dataset.sourceEnd = String(range.end);
        sourceButton.dataset.sourceKind = range.kind ?? 'index';
        sourceButton.textContent = 'Source';
        actions.append(sourceButton);
      }
      if (node.event_id) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'menu_button';
        edit.dataset.explorerAction = 'edit-timeline';
        edit.dataset.eventId = node.event_id;
        edit.textContent = 'Set interpretation';
        actions.append(edit);
      }
      if (actions.childElementCount > 0) card.append(actions);

      marker.append(card);
      spineElement.append(marker);
    });
    root.append(spineElement);
  } else {
    const summary = document.createElement('div');
    summary.className = 'sm-muted sm-product-explorer-summary';
    summary.textContent = `${model.narrative.layerCount} narrative layer${model.narrative.layerCount === 1 ? '' : 's'} · ${model.narrative.snippets} snippet${model.narrative.snippets === 1 ? '' : 's'}${model.narrative.stale ? ' · refresh needed' : ''}`;
    const regenerateButton = document.createElement('button');
    regenerateButton.type = 'button';
    regenerateButton.className = 'menu_button';
    regenerateButton.dataset.explorerAction = 'regenerate-narrative';
    regenerateButton.textContent = 'Regenerate narrative';
    summary.append(' ', regenerateButton);
    root.append(summary);
    const narrative = document.createElement('div');
    narrative.className = 'sm-product-explorer-narrative';
    if (model.narrative.snippets === 0) {
      const empty = document.createElement('div');
      empty.className = 'sm-product-empty';
      empty.textContent = 'No narrative continuity has been generated for this chat yet.';
      narrative.append(empty);
    }
    model.narrative.layers.forEach((layer, layerIndex) => {
      const group = document.createElement('details');
      group.open = layerIndex === 0;
      const heading = document.createElement('summary');
      heading.textContent = `Narrative layer ${layerIndex} (${layer.length} snippet${layer.length === 1 ? '' : 's'})`;
      group.append(heading);
      for (const snippet of layer) {
        const item = document.createElement('div');
        item.className = 'sm-product-explorer-snippet';
        item.textContent = String(snippet?.text ?? '');
        const range = normalizedRange(snippet?.source_range ?? snippet?.sourceRange);
        if (range) {
          const sourceButton = document.createElement('button');
          sourceButton.type = 'button';
          sourceButton.className = 'menu_button';
          sourceButton.dataset.explorerAction = 'jump-source';
          sourceButton.dataset.sourceStart = String(range.start);
          sourceButton.dataset.sourceEnd = String(range.end);
          sourceButton.dataset.sourceKind = range.kind;
          sourceButton.textContent = 'Source';
          item.append(' ', sourceButton);
        }
        group.append(item);
      }
      narrative.append(group);
    });
    root.append(narrative);
  }

  container.append(root);
}

function formatSourceRange(range) {
  const normalizedRangeValue = normalizedRange(range);
  if (!normalizedRangeValue) return 'source unavailable';
  const kind = normalizedRangeValue.kind === 'mesId' ? 'messages' : 'chat positions';
  return `source ${kind} ${normalizedRangeValue.start ?? '?'}–${normalizedRangeValue.end ?? '?'}`;
}

function formatStoryTime(anchor) {
  if (!anchor || typeof anchor !== 'object') return 'Story time unknown';
  const parts = [
    anchor.year === undefined ? null : `Year ${anchor.year}`,
    anchor.month === undefined ? null : `Month ${anchor.month}`,
    anchor.day === undefined ? null : `Day ${anchor.day}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Story time unknown';
}

export { PRODUCT_KINDS };
