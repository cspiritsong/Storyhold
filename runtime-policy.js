/** Canonical product/compatibility mode decisions for Storyhold runtime paths. */

const EPISTEMIC_TYPES = new Set(['knows', 'suspects', 'unaware', 'believes', 'hiding']);

export function isProductMode(settings = {}) {
  return settings?.single_extension_mode === true;
}

export function shouldInjectDirectRepair(settings = {}) {
  return !isProductMode(settings);
}

export function shouldRunProductIngest(
  settings = {},
  { freshStart = false, lineageQuarantined = false, controlBusy = false } = {},
) {
  return isProductMode(settings) && settings.enabled !== false && !freshStart && !lineageQuarantined && !controlBusy;
}

export function enabledProductKinds(settings = {}) {
  return [
    settings.longterm_enabled !== false ? 'fact' : null,
    'event',
    settings.relationships_enabled !== false ? 'relationship' : null,
    settings.state_ledger_enabled === true ? 'state' : null,
    settings.arcs_enabled !== false ? 'arc' : null,
    settings.epistemic_enabled !== false ? 'epistemic' : null,
    settings.session_enabled !== false ? 'session' : null,
  ].filter(Boolean);
}

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

function witnesses(record) {
  if (Array.isArray(record?.witnessed_by)) return record.witnessed_by.map(normalized).filter(Boolean);
  if (Array.isArray(record?.scope?.witnessed_by)) {
    return record.scope.witnessed_by.map(normalized).filter(Boolean);
  }
  return [];
}

export function filterProductRecords(records = [], settings = {}, respondingCharacter = null) {
  if (settings.enabled === false) return [];
  const enabled = new Set(enabledProductKinds(settings));
  const responder = normalized(respondingCharacter);
  return (Array.isArray(records) ? records : []).filter((record) => {
    if (!record || !enabled.has(record.kind)) return false;
    if (record.kind === 'fact' && settings.epistemic_secondhand_framing === false) {
      const knownWitnesses = witnesses(record);
      if (responder && knownWitnesses.length > 0 && !knownWitnesses.includes(responder)) return false;
    }
    if (record.kind !== 'epistemic') return true;
    const type = normalized(record.type);
    if (!EPISTEMIC_TYPES.has(type)) return false;
    if (type === 'unaware' && settings.epistemic_inject_unaware === false) return false;
    const subject = normalized(record.subject);
    return Boolean(responder && subject && subject === responder);
  });
}

const KNOWN_ADVISORY_REASONS = new Set([
  'record-edited',
  'records-changed',
  'timeline-edited',
]);

/**
 * Returns whether prompt injection may include the narrative state given a narrative_stale marker.
 *
 * Absent markers allow injection. Explicit blocks_injection booleans take precedence.
 * Known legacy advisory reasons allow injection when blocks_injection is omitted.
 * Unknown reasons and malformed markers fail closed (block injection).
 */
export function narrativeInjectionAllowed(marker) {
  if (marker === null || marker === undefined) return true;
  if (typeof marker !== 'object' || Array.isArray(marker)) return false;
  const keys = Object.keys(marker);
  if (keys.length === 0) return false;

  if ('blocks_injection' in marker) {
    if (typeof marker.blocks_injection !== 'boolean') return false;
    return !marker.blocks_injection;
  }

  if (typeof marker.reason !== 'string' || !marker.reason.trim()) return false;
  return KNOWN_ADVISORY_REASONS.has(marker.reason.trim());
}
