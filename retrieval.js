/**
 * Deterministic-first retrieval for Smart-Memory's broker.
 *
 * The normal path is deliberately synchronous in spirit: exact/entity and
 * lexical/structured matching should satisfy common turns without an LLM or
 * embedding request. Optional vector and agentic callbacks are only consulted
 * after a deterministic miss.
 */

import { keywordSet } from './memory-utils.js';

export const RETRIEVAL_STAGE = Object.freeze({
  EXACT: 'exact',
  STRUCTURED: 'structured',
  LEXICAL: 'lexical',
  VECTOR: 'vector',
  AGENTIC: 'agentic',
});

const ACTIVE_VALIDITY = new Set(['active', 'uncertain']);
const STRUCTURED_KINDS = new Set(['state', 'relationship', 'arc', 'epistemic']);

function normalized(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function queryObject(query) {
  if (typeof query === 'string') return { text: query, entities: [] };
  return {
    text: String(query?.text ?? ''),
    entities: Array.isArray(query?.entities) ? query.entities.map(normalized).filter(Boolean) : [],
    intent: query?.intent ?? null,
    keys: Array.isArray(query?.keys) ? query.keys.map(normalized).filter(Boolean) : [],
  };
}

function sourceChatUid(record) {
  return (
    record?.scope?.chat_uid ??
    record?.provenance?.source_chat_uid ??
    record?.source_chat_uid ??
    record?.source_chat_id ??
    null
  );
}

function sourceBranchUid(record) {
  return record?.scope?.branch_uid ?? record?.branch_uid ?? record?.lineage_epoch ?? null;
}

function witnesses(record) {
  if (Array.isArray(record?.witnessed_by)) return record.witnessed_by.map(normalized).filter(Boolean);
  if (Array.isArray(record?.scope?.witnessed_by)) {
    return record.scope.witnessed_by.map(normalized).filter(Boolean);
  }
  return [];
}

/**
 * Applies hard scope, validity, and POV filters. Missing branch metadata is
 * treated as legacy same-chat data; foreign explicit metadata is rejected.
 */
export function filterRetrievalRecords(
  records,
  {
    chatUid,
    branchUid = null,
    respondingCharacter = null,
    povMode = 'allow-secondhand',
    lineage = null,
    allowLegacy = true,
  } = {},
) {
  if (lineage?.quarantined) return [];
  const expectedChat = normalized(chatUid);
  if (!expectedChat) return [];

  return (Array.isArray(records) ? records : [])
    .filter((record) => {
      if (!record || typeof record !== 'object') return false;
      if (record.superseded_by) return false;
      const validity = record.validity?.status ?? record.status ?? 'active';
      if (!ACTIVE_VALIDITY.has(validity)) return false;

      const actualChat = normalized(sourceChatUid(record));
      if (!actualChat) return allowLegacy === true && record.legacy === true;
      if (actualChat !== expectedChat) return false;

      const actualBranch = sourceBranchUid(record);
      if (
        branchUid != null &&
        actualBranch != null &&
        normalized(actualBranch) !== normalized(branchUid)
      ) {
        return false;
      }

      const currentCharacter = normalized(respondingCharacter);
      const knownWitnesses = witnesses(record);
      if (
        currentCharacter &&
        knownWitnesses.length > 0 &&
        !knownWitnesses.includes(currentCharacter) &&
        povMode === 'strict'
      ) {
        return false;
      }
      return true;
    })
    .map((record) => {
      const currentCharacter = normalized(respondingCharacter);
      const knownWitnesses = witnesses(record);
      const secondhand =
        Boolean(currentCharacter) &&
        knownWitnesses.length > 0 &&
        !knownWitnesses.includes(currentCharacter);
      return secondhand ? { ...record, _retrieval_pov: 'secondhand' } : { ...record };
    });
}

function recordText(record) {
  return normalized(record?.content ?? record?.text ?? record?.summary ?? '');
}

function recordEntities(record) {
  const values = [
    ...(Array.isArray(record?.entities) ? record.entities : []),
    ...(Array.isArray(record?.entity_names) ? record.entity_names : []),
    ...(record?.subject ? [record.subject] : []),
    ...(record?.target ? [record.target] : []),
  ];
  return values.map(normalized).filter(Boolean);
}

function recordKeys(record) {
  return [
    ...(Array.isArray(record?.triggers) ? record.triggers : []),
    ...(Array.isArray(record?.keywords) ? record.keywords : []),
    ...(Array.isArray(record?.keys) ? record.keys : []),
  ]
    .map(normalized)
    .filter(Boolean);
}

function exactScore(record, query) {
  const text = recordText(record);
  const phrase = normalized(query.text);
  if (phrase && text.includes(phrase)) return 1;

  const queryKeys = new Set([...query.entities, ...query.keys]);
  if (queryKeys.size === 0) return 0;
  const haystacks = [...recordEntities(record), ...recordKeys(record), text];
  return [...queryKeys].some((key) => haystacks.some((value) => value === key || value.includes(key)))
    ? 0.8
    : 0;
}

function lexicalScore(record, query) {
  const queryTokens = keywordSet(query.text);
  if (queryTokens.size === 0) return 0;
  const recordTokens = keywordSet(recordText(record));
  if (recordTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) if (recordTokens.has(token)) overlap++;
  return overlap / queryTokens.size;
}

function structuredScore(record, query) {
  if (!query.intent || !STRUCTURED_KINDS.has(record?.kind)) return 0;
  const intent = normalized(query.intent);
  const kind = normalized(record.kind);
  if (intent === 'current_state' && kind === 'state') return 0.75;
  if (intent === 'relationship' && kind === 'relationship') return 0.75;
  if (intent === 'arc' && kind === 'arc') return 0.75;
  if (intent === 'knowledge' && kind === 'epistemic') return 0.75;
  return 0;
}

function utilityTieBreak(record) {
  const importance = Number(record?.importance ?? 0);
  const confidence = Number(record?.confidence ?? 0);
  const timestamp = Number(record?.knowledge_time?.mes_id ?? record?.ts ?? 0);
  return importance * 0.001 + confidence * 0.0001 + timestamp * 0.000000001;
}

function annotate(record, stage, score, signals = {}) {
  return {
    ...record,
    retrieval: {
      stage,
      score,
      signals,
    },
  };
}

function deterministicCandidates(records, query, options) {
  const eligible = filterRetrievalRecords(records, options);
  const ranked = [];
  for (const record of eligible) {
    const exact = exactScore(record, query);
    const structured = structuredScore(record, query);
    const lexical = lexicalScore(record, query);
    const best = Math.max(exact, structured, lexical);
    if (best <= 0) continue;
    const stage =
      exact > 0
        ? RETRIEVAL_STAGE.EXACT
        : structured > 0
          ? RETRIEVAL_STAGE.STRUCTURED
          : RETRIEVAL_STAGE.LEXICAL;
    ranked.push({
      record: annotate(record, stage, best + utilityTieBreak(record), {
        exact,
        structured,
        lexical,
      }),
      rank: best + utilityTieBreak(record),
    });
  }
  return ranked
    .sort((a, b) => b.rank - a.rank)
    .map(({ record }) => record);
}

function callbackRecords(result) {
  const values = result?.records ?? result;
  if (!Array.isArray(values)) return [];
  return values.map((value) => value?.record ?? value).filter(Boolean);
}

function scopedExternalCandidates(records, stage, options) {
  return filterRetrievalRecords(records, options).map((record, index) =>
    annotate(
      record,
      stage,
      Number(record?.relevance ?? record?.score ?? 0.5) - index * 0.000001,
      { external: true },
    ),
  );
}

/**
 * Runs the deterministic-first retrieval ladder.
 *
 * `vectorSearch` and `agenticSearch` receive the normalized query object and
 * may return records or `{ records }`. They are never called when a
 * deterministic candidate already exists.
 */
export async function retrieveWithLadder({
  records = [],
  query = '',
  chatUid,
  branchUid = null,
  respondingCharacter = null,
  povMode = 'allow-secondhand',
  lineage = null,
  allowLegacy = true,
  maxResults = 8,
  vectorSearch = null,
  agenticSearch = null,
  allowVector = true,
  allowAgentic = false,
} = {}) {
  const normalizedQuery = queryObject(query);
  const filterOptions = {
    chatUid,
    branchUid,
    respondingCharacter,
    povMode,
    lineage,
    allowLegacy,
  };
  const diagnostics = {
    vector_called: false,
    agentic_called: false,
    vector_error: null,
    agentic_error: null,
  };
  const deterministic = deterministicCandidates(records, normalizedQuery, filterOptions);
  if (deterministic.length > 0) {
    return {
      candidates: deterministic.slice(0, maxResults),
      stage: deterministic[0].retrieval.stage,
      diagnostics,
    };
  }

  if (allowVector && typeof vectorSearch === 'function' && normalizedQuery.text.trim()) {
    diagnostics.vector_called = true;
    try {
      const vectorResult = await vectorSearch(normalizedQuery);
      const vectorCandidates = scopedExternalCandidates(
        callbackRecords(vectorResult),
        RETRIEVAL_STAGE.VECTOR,
        filterOptions,
      );
      if (vectorCandidates.length > 0) {
        return {
          candidates: vectorCandidates.slice(0, maxResults),
          stage: RETRIEVAL_STAGE.VECTOR,
          diagnostics,
        };
      }
    } catch (error) {
      diagnostics.vector_error = error instanceof Error ? error.message : String(error);
    }
  }

  if (allowAgentic && typeof agenticSearch === 'function' && normalizedQuery.text.trim()) {
    diagnostics.agentic_called = true;
    try {
      const agenticResult = await agenticSearch(normalizedQuery);
      const agenticCandidates = scopedExternalCandidates(
        callbackRecords(agenticResult),
        RETRIEVAL_STAGE.AGENTIC,
        filterOptions,
      );
      if (agenticCandidates.length > 0) {
        return {
          candidates: agenticCandidates.slice(0, maxResults),
          stage: RETRIEVAL_STAGE.AGENTIC,
          diagnostics,
        };
      }
    } catch (error) {
      diagnostics.agentic_error = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    candidates: [],
    stage: null,
    diagnostics,
  };
}
