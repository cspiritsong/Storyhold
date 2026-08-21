/**
 * Runtime bridge for the pure ingest queue.
 *
 * It adapts SillyTavern-like chat metadata to the queue's load/save contract,
 * while keeping the queue itself independent of the browser and ST internals.
 */

import { createIngestQueue } from './ingest-queue.js';
import { buildIngestWindow } from './projections.js';
import { META_KEY } from './constants.js';

const DEFAULT_META_KEY = META_KEY;
const DEFAULT_QUEUE_KEY = 'ingest_windows';

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function assertMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('chat metadata must be an object');
  }
}

/**
 * Creates a queue store backed by a chatMetadata-like object. Queue writes are
 * copied so a projector cannot mutate the persisted snapshot after save.
 */
export function createMetadataIngestStore({
  metadata,
  metaKey = DEFAULT_META_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  saveMetadata = async () => {},
} = {}) {
  assertMetadata(metadata);
  if (typeof saveMetadata !== 'function') throw new TypeError('saveMetadata must be a function');

  const root = (metadata[metaKey] ??= {});
  if (!root[queueKey] || typeof root[queueKey] !== 'object' || Array.isArray(root[queueKey])) {
    root[queueKey] = {};
  }
  const windows = root[queueKey];

  return {
    async load(windowId) {
      return clone(windows[windowId] ?? null);
    },
    async save(windowId, state) {
      windows[windowId] = clone(state);
      await saveMetadata();
    },
  };
}


/** Creates a snapshotting store for one value under a chat metadata root. */
export function createMetadataValueStore({
  metadata,
  metaKey = DEFAULT_META_KEY,
  valueKey,
  saveMetadata = async () => {},
} = {}) {
  assertMetadata(metadata);
  if (typeof valueKey !== 'string' || valueKey.trim() === '') {
    throw new TypeError('valueKey must be a non-empty string');
  }
  if (typeof saveMetadata !== 'function') throw new TypeError('saveMetadata must be a function');

  const root = (metadata[metaKey] ??= {});
  return {
    async load() {
      return clone(root[valueKey] ?? null);
    },
    async save(value) {
      root[valueKey] = clone(value);
      await saveMetadata();
    },
  };
}

export function buildWindowFromChat({
  chat,
  chatUid,
  branchUid = null,
  startIndex = 0,
  endIndex = Array.isArray(chat) ? chat.length - 1 : -1,
  lineage = null,
} = {}) {
  if (!Array.isArray(chat)) throw new TypeError('chat must be an array');
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new TypeError('startIndex must be a non-negative integer');
  }
  if (!Number.isInteger(endIndex) || endIndex < startIndex) {
    throw new TypeError('endIndex must be an integer not smaller than startIndex');
  }

  const messages = chat.slice(startIndex, endIndex + 1).map((message) => ({ ...message }));
  const mesIds = messages
    .map((message) => message?.mesId)
    .filter((mesId) => typeof mesId === 'number' && Number.isInteger(mesId) && mesId >= 0);
  const hasCompleteMesIds = messages.length > 0 && mesIds.length === messages.length;
  const sourceRange = hasCompleteMesIds
    ? { kind: 'mesId', start: Math.min(...mesIds), end: Math.max(...mesIds) }
    : { kind: 'index', start: startIndex, end: endIndex };

  return buildIngestWindow({
    chatUid,
    branchUid,
    messages,
    sourceRange,
    lineage,
  });
}

/** Creates a queue whose state is persisted in the supplied chat metadata. */
export function createRuntimeIngestQueue({
  metadata,
  metaKey = DEFAULT_META_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  saveMetadata = async () => {},
  projectors = {},
  now = () => Date.now(),
} = {}) {
  const store = createMetadataIngestStore({ metadata, metaKey, queueKey, saveMetadata });
  return createIngestQueue({ ...store, projectors, now });
}
