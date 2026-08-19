const DAY_PATTERN = /\bday\s+(\d{1,3})\b/gi;
const FULL_DATE_PATTERN = /\byear\s+(\d{3,4})\D+month\s+(\d{1,2})\D+day\s+(\d{1,3})\b/i;

function cleanText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/**
 * Extracts the last explicit story-time anchor in a text fragment.
 * Unknown dates remain null; this function never invents a clock value.
 */
export function extractTemporalAnchor(text) {
  const value = cleanText(text);
  const full = value.match(FULL_DATE_PATTERN);
  if (full) {
    return { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) };
  }

  const days = [...value.matchAll(DAY_PATTERN)];
  if (days.length === 0) return null;
  return { day: Number(days.at(-1)[1]) };
}

export function classifyNarrativeRole(text) {
  const value = cleanText(text).toLowerCase();
  if (/\b(hypothetical|imagine|if\s+|would\s+|could\s+|might\s+)/i.test(value)) {
    return 'hypothetical';
  }
  if (/\b(flashback|remembered|memory of|years? ago|months? ago|days? earlier|back then|before the current)\b/i.test(value)) {
    return value.includes('flashback') || value.includes('memory of') ? 'flashback' : 'backstory';
  }
  if (/\b(rumou?r|reportedly|heard that|they say|allegedly)\b/i.test(value)) return 'rumor';
  return 'current';
}

function compareAnchors(left, right) {
  for (const key of ['year', 'month', 'day']) {
    if (left?.[key] === undefined || right?.[key] === undefined) continue;
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

function formatAnchor(anchor) {
  if (!anchor) return 'unknown';
  return [
    anchor.year === undefined ? null : `Year ${anchor.year}`,
    anchor.month === undefined ? null : `Month ${String(anchor.month).padStart(2, '0')}`,
    anchor.day === undefined ? null : `Day ${anchor.day}`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Rebuilds a compact timeline ledger from raw chat messages.
 *
 * The ledger deliberately keeps separate:
 * - conversation_index: where the statement appeared;
 * - story_time: when the event claims to happen;
 * - knowledge_time: when the chat revealed it;
 * - validity: the current validity interval for the projection.
 */
export function rebuildTimeline(messages, { chatId = null, epochId = null } = {}) {
  const chat = Array.isArray(messages) ? messages : [];
  const events = [];
  const conflicts = [];
  let currentAnchor = null;
  let previousCurrentEvent = null;

  for (let index = 0; index < chat.length; index++) {
    const text = chat[index]?.mes ?? '';
    const storyTime = extractTemporalAnchor(text);
    if (!storyTime) continue;

    const narrativeRole = classifyNarrativeRole(text);
    const effectiveStoryTime =
      narrativeRole === 'current' && currentAnchor
        ? { ...currentAnchor, ...storyTime }
        : storyTime;
    const event = {
      event_id: `${epochId ?? chatId ?? 'timeline'}:${index}`,
      origin_chat_id: chatId,
      source_message_range: [index, index],
      conversation_index: index,
      story_epoch: epochId,
      story_time: effectiveStoryTime,
      knowledge_time: { conversation_index: index },
      validity: { from: effectiveStoryTime, to: null },
      narrative_role: narrativeRole,
      temporal_relations: [],
      confidence: narrativeRole === 'current' ? 1 : 0.8,
      supersedes: [],
      contradicts: [],
    };
    events.push(event);

    if (narrativeRole !== 'current') continue;
    if (
      previousCurrentEvent &&
      compareAnchors(effectiveStoryTime, previousCurrentEvent.story_time) < 0
    ) {
      event.contradicts.push(previousCurrentEvent.event_id);
      previousCurrentEvent.contradicts.push(event.event_id);
      conflicts.push({
        type: 'progression-reversal',
        earlier_event_id: previousCurrentEvent.event_id,
        later_event_id: event.event_id,
        earlier_anchor: previousCurrentEvent.story_time,
        later_anchor: effectiveStoryTime,
      });
    }
    currentAnchor = effectiveStoryTime;
    previousCurrentEvent = event;
  }

  return {
    schema_version: 1,
    chat_id: chatId,
    story_epoch: epochId,
    current_anchor: currentAnchor,
    events,
    conflicts,
  };
}

/**
 * Returns false when a current-state projection asserts a different explicit
 * clock than the reconciled timeline. Historical/backstory wording is allowed
 * to mention older dates without becoming the current clock.
 */
export function isProjectionTemporallyCompatible(text, timeline) {
  const role = classifyNarrativeRole(text);
  if (role !== 'current') return true;
  const projectionAnchor = extractTemporalAnchor(text);
  const currentAnchor = timeline?.current_anchor;
  if (!projectionAnchor || !currentAnchor) return true;
  return compareAnchors(projectionAnchor, currentAnchor) === 0;
}

/**
 * Compact projection inserted into existing session context; no raw chat text
 * is included and no new user-facing setting is required.
 */
export function buildTimelinePromptBlock(timeline) {
  const lines = [`Story clock: ${formatAnchor(timeline?.current_anchor)}.`];
  if ((timeline?.conflicts?.length ?? 0) > 0) {
    lines.push(
      `Timeline warning: ${timeline.conflicts.length} temporal conflict(s); current progression is uncertain.`,
    );
  }
  return lines.join('\n');
}
