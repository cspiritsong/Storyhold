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
  CANCELLED: 'cancelled',
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function reportProgress(callback, event) {
  if (typeof callback !== 'function') return;
  try {
    const result = callback(event);
    if (result && typeof result.then === 'function') {
      result.catch((error) => {
        console.warn('[Storyhold] Progress callback failed:', error);
      });
    }
  } catch (error) {
    console.warn('[Storyhold] Progress callback failed:', error);
  }
}

function assertNotAborted(context) {
  if (typeof context?.shouldAbort === 'function' && context.shouldAbort()) {
    throw new Error('ingest aborted');
  }
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
    start_index: window.start_index ?? null,
    end_index: window.end_index ?? null,
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

export function pruneIngestWindowsAtBranch(
  windows = {},
  { branchPointMesId, branchPointIndex = null } = {},
) {
  const kept = {};
  const removed = [];
  for (const [windowId, state] of Object.entries(windows ?? {})) {
    const range = state?.source_range;
    const isTail =
      (range?.kind === 'mesId' &&
        (!Number.isInteger(branchPointMesId) ||
          (Number.isInteger(range.end) && range.end > branchPointMesId))) ||
      (range?.kind === 'index' && Number.isInteger(branchPointIndex) && range.end > branchPointIndex);
    if (isTail) {
      removed.push({ window_id: windowId, state: structuredClone(state) });
    } else {
      kept[windowId] = structuredClone(state);
    }
  }
  return { windows: kept, removed, changed: removed.length > 0 };
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
      const onProgress = context.onProgress;
      if (!window?.window_id || !window.chat_uid || !window.source_range) {
        throw new TypeError('ingest requires a canonical window');
      }
      assertNotAborted(context);

      const prior = (await load(window.window_id)) ?? null;
      assertNotAborted(context);
      if (window.quarantined || window.lineage?.quarantined) {
        const quarantined = {
          ...(prior ?? initialState(window, now)),
          status: INGEST_STATUS.QUARANTINED,
          injectable_record_ids: [],
          updated_at: now(),
        };
        assertNotAborted(context);
        await save(window.window_id, quarantined);
        reportProgress(onProgress, {
          phase: 'window_complete',
          windowId: window.window_id,
          status: INGEST_STATUS.QUARANTINED,
          recordCount: 0,
        });
        return { ...quarantined, record_ids: [], replayed: false };
      }

      if (prior && prior.status === INGEST_STATUS.COMPLETED && allProjectorsCompleted(prior, names) && !context.forceReprocess) {
        reportProgress(onProgress, {
          phase: 'window_complete',
          windowId: window.window_id,
          status: INGEST_STATUS.COMPLETED,
          recordCount: prior.records?.length ?? 0,
          replayed: true,
        });
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
        start_index: window.start_index ?? null,
        end_index: window.end_index ?? null,
        source_range: window.source_range,
        fingerprint: window.fingerprint,
        status: INGEST_STATUS.RUNNING,
        failures: [],
        updated_at: now(),
      };
      if (context.forceReprocess) {
        state.projections = {};
        state.records = [];
      }
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
        assertNotAborted(context);
        await save(window.window_id, state);
        reportProgress(onProgress, {
          phase: 'projection_start',
          windowId: window.window_id,
          projection: name,
          attempt: previousAttempts + 1,
        });

        try {
          const rawResult = await projector(window, context);
          assertNotAborted(context);
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
          assertNotAborted(context);
        } catch (error) {
          if (context.isCancelled?.() === true) {
            state.projections[name] = {
              status: INGEST_STATUS.CANCELLED,
              attempts: previousAttempts + 1,
              error: errorMessage(error),
              updated_at: now(),
            };
            state.status = INGEST_STATUS.CANCELLED;
            state.cancelled = true;
            state.cancel_reason = errorMessage(error);
            state.record_ids = (state.records ?? []).map((record) => record.id);
            state.updated_at = now();
            if (typeof context.saveCancelled !== 'function') throw error;
            await context.saveCancelled(window.window_id, state);
            reportProgress(onProgress, {
              phase: 'projection_cancelled',
              windowId: window.window_id,
              projection: name,
              status: state.status,
              recordCount: state.records?.length ?? 0,
              error: state.cancel_reason,
            });
            reportProgress(onProgress, {
              phase: 'window_complete',
              windowId: window.window_id,
              status: state.status,
              recordCount: state.records?.length ?? 0,
              cancelled: true,
            });
            return { ...state, replayed: false };
          }
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
        assertNotAborted(context);
        await save(window.window_id, state);
        const projection = state.projections[name];
        reportProgress(onProgress, {
          phase: projection.status === 'completed' ? 'projection_complete' : 'projection_failed',
          windowId: window.window_id,
          projection: name,
          status: projection.status,
          recordCount: projection.record_ids?.length ?? 0,
          error: projection.error ?? null,
        });
      }

      const failed = names.some((name) => state.projections[name]?.status === 'failed');
      state.status = failed ? INGEST_STATUS.PARTIAL : INGEST_STATUS.COMPLETED;
      state.record_ids = (state.records ?? []).map((record) => record.id);
      state.updated_at = now();
      assertNotAborted(context);
      await save(window.window_id, state);
      reportProgress(onProgress, {
        phase: 'window_complete',
        windowId: window.window_id,
        status: state.status,
        recordCount: state.records?.length ?? 0,
        replayed: false,
      });
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
