/**
 * Resumable, idempotent ingest queue for typed Smart-Memory projections.
 *
 * The queue is deliberately independent of SillyTavern storage. Callers provide
 * load/save functions so tests can use a Map and the runtime can persist the
 * same state in chatMetadata later without changing queue semantics.
 */

import { normalizeDerivedRecord } from './projections.js';

export const INGEST_STATUS = Object.freeze({
  RUNNING: 'running',
  PARTIAL: 'partial',
  COMPLETED: 'completed',
  QUARANTINED: 'quarantined',
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resultRecords(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.records)) return result.records;
  return [];
}

function initialState(window, now) {
  return {
    window_id: window.window_id,
    chat_uid: window.chat_uid,
    branch_uid: window.branch_uid ?? null,
    source_range: window.source_range,
    fingerprint: window.fingerprint,
    status: INGEST_STATUS.RUNNING,
    projections: {},
    records: [],
    failures: [],
    created_at: now(),
    updated_at: now(),
  };
}

function mergeRecords(existing, incoming) {
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()];
}

function allProjectorsCompleted(state, names) {
  return names.every((name) => state.projections[name]?.status === 'completed');
}

/**
 * @param {{load: Function, save: Function, projectors?: Record<string, Function>, now?: Function}} options
 */
export function createIngestQueue({ load, save, projectors = {}, now = () => Date.now() } = {}) {
  if (typeof load !== 'function' || typeof save !== 'function') {
    throw new TypeError('ingest queue requires load and save functions');
  }
  const entries = Object.entries(projectors).filter(([, projector]) => typeof projector === 'function');
  const names = entries.map(([name]) => name);

  const ingestWindow = async (window, context = {}) => {
      if (!window?.window_id || !window.chat_uid || !window.source_range) {
        throw new TypeError('ingest requires a canonical window');
      }

      const prior = (await load(window.window_id)) ?? null;
      if (window.quarantined || window.lineage?.quarantined) {
        const quarantined = {
          ...(prior ?? initialState(window, now)),
          status: INGEST_STATUS.QUARANTINED,
          injectable_record_ids: [],
          updated_at: now(),
        };
        await save(window.window_id, quarantined);
        return { ...quarantined, record_ids: [], replayed: false };
      }

      if (prior && prior.status === INGEST_STATUS.COMPLETED && allProjectorsCompleted(prior, names)) {
        return {
          ...prior,
          record_ids: (prior.records ?? []).map((record) => record.id),
          replayed: true,
        };
      }

      const state = {
        ...(prior ?? initialState(window, now)),
        window_id: window.window_id,
        chat_uid: window.chat_uid,
        branch_uid: window.branch_uid ?? null,
        source_range: window.source_range,
        fingerprint: window.fingerprint,
        status: INGEST_STATUS.RUNNING,
        failures: [],
        updated_at: now(),
      };
      await save(window.window_id, state);

      for (const [name, projector] of entries) {
        if (state.projections[name]?.status === 'completed') continue;

        const previousAttempts = state.projections[name]?.attempts ?? 0;
        state.projections[name] = {
          status: INGEST_STATUS.RUNNING,
          attempts: previousAttempts + 1,
          updated_at: now(),
        };
        state.updated_at = now();
        await save(window.window_id, state);

        try {
          const rawResult = await projector(window, context);
          const normalized = resultRecords(rawResult).map((record) =>
            normalizeDerivedRecord(record, window),
          );
          state.records = mergeRecords(state.records ?? [], normalized);
          state.projections[name] = {
            status: 'completed',
            attempts: previousAttempts + 1,
            record_ids: normalized.map((record) => record.id),
            updated_at: now(),
          };
        } catch (error) {
          state.projections[name] = {
            status: 'failed',
            attempts: previousAttempts + 1,
            error: errorMessage(error),
            updated_at: now(),
          };
          state.failures.push({
            projection: name,
            error: errorMessage(error),
            attempt: previousAttempts + 1,
          });
        }
        state.updated_at = now();
        await save(window.window_id, state);
      }

      const failed = names.some((name) => state.projections[name]?.status === 'failed');
      state.status = failed ? INGEST_STATUS.PARTIAL : INGEST_STATUS.COMPLETED;
      state.record_ids = (state.records ?? []).map((record) => record.id);
      state.updated_at = now();
      await save(window.window_id, state);
      return { ...state, replayed: false };
  };

  const inFlight = new Map();
  return {
    async ingest(window, context = {}) {
      const windowId = window?.window_id;
      if (!windowId) return ingestWindow(window, context);
      const active = inFlight.get(windowId);
      if (active) return active;
      const operation = ingestWindow(window, context);
      inFlight.set(windowId, operation);
      try {
        return await operation;
      } finally {
        if (inFlight.get(windowId) === operation) inFlight.delete(windowId);
      }
    },
  };
}
