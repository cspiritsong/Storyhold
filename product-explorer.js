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
    const listElement = document.createElement('div');
    listElement.className = 'sm-product-explorer-timeline';
    if (model.timeline.events.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sm-product-empty';
      empty.textContent = 'No timeline events have been derived from this chat yet.';
      listElement.append(empty);
    }
    for (const event of model.timeline.events) {
      const row = document.createElement('div');
      row.className = 'sm-product-explorer-event';
      row.dataset.eventId = event.event_id;
      const when = document.createElement('span');
      when.className = 'sm-product-explorer-event-when';
      when.textContent = formatStoryTime(event.story_time);
      const role = document.createElement('span');
      role.className = 'sm-memory-status';
      role.textContent = event.narrative_role ?? 'current';
      const text = document.createElement('span');
      text.className = 'sm-product-explorer-event-text';
      const eventRange = normalizedRange(event.source_message_range ?? event.source_range);
      text.textContent = `message ${event.conversation_index ?? 'unknown'} · ${formatSourceRange(eventRange)}`;
      const sourcePreviewElement = document.createElement('div');
      sourcePreviewElement.className = 'sm-product-explorer-event-preview';
      sourcePreviewElement.textContent = event.source_preview ?? 'source preview unavailable';
      const actions = document.createElement('div');
      actions.className = 'sm-product-explorer-record-actions';
      if (eventRange && Number.isInteger(eventRange.start) && Number.isInteger(eventRange.end)) {
        const sourceButton = document.createElement('button');
        sourceButton.type = 'button';
        sourceButton.className = 'menu_button';
        sourceButton.dataset.explorerAction = 'jump-source';
        sourceButton.dataset.sourceStart = String(eventRange.start);
        sourceButton.dataset.sourceEnd = String(eventRange.end);
        sourceButton.dataset.sourceKind = eventRange.kind ?? 'index';
        sourceButton.textContent = 'Source';
        actions.append(sourceButton);
      }
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'menu_button';
      edit.dataset.explorerAction = 'edit-timeline';
      edit.dataset.eventId = event.event_id;
      edit.textContent = event.manual_override ? 'Edit override' : 'Set interpretation';
      actions.append(edit);
      row.append(when, role, text, sourcePreviewElement, actions);
      listElement.append(row);
    }
    root.append(listElement);
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
