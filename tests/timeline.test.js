import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimelinePromptBlock,
  extractTemporalAnchor,
  isProjectionTemporallyCompatible,
  rebuildTimeline,
} from '../timeline.js';

const msg = (mes, extra = {}) => ({ name: 'Narrator', mes, ...extra });

test('backstory anchor does not move the current story clock', () => {
  const timeline = rebuildTimeline(
    [
      msg('The story is now Year 2041, Month 09, Day 15.'),
      msg('Years ago, on Day 12, Maeve fought Gustav in Djibouti.'),
      msg('The next morning is Day 16.'),
    ],
    { chatId: 'chat-30', epochId: 'epoch-30' },
  );

  assert.deepEqual(timeline.current_anchor, { year: 2041, month: 9, day: 16 });
  assert.equal(timeline.events[1].narrative_role, 'backstory');
  assert.deepEqual(timeline.events[1].story_time, { day: 12 });
  assert.deepEqual(timeline.events[1].knowledge_time, { conversation_index: 1 });
  assert.equal(timeline.conflicts.length, 0);
});

test('unexplained backward progression is recorded as a conflict', () => {
  const timeline = rebuildTimeline(
    [msg('Current story time: Day 15.'), msg('The room is now on Day 12.')],
    { chatId: 'chat-30', epochId: 'epoch-30' },
  );

  assert.deepEqual(timeline.current_anchor, { day: 12 });
  assert.equal(timeline.conflicts.length, 1);
  assert.equal(timeline.conflicts[0].type, 'progression-reversal');
});

test('temporal anchor parser leaves unknown dates unknown', () => {
  assert.deepEqual(extractTemporalAnchor('They discussed the plan in the kitchen.'), null);
  assert.deepEqual(extractTemporalAnchor('Year 2041, Month 09, Day 15'), {
    year: 2041,
    month: 9,
    day: 15,
  });
});

test('stale current-state projection is rejected but historical wording is allowed', () => {
  const timeline = rebuildTimeline([msg('Current story time is Day 15.')], {
    chatId: 'chat-30',
    epochId: 'epoch-30',
  });

  assert.equal(
    isProjectionTemporallyCompatible('Time: Year 2041, Month 09, advancing from Day 12 into Day 13.' , timeline),
    false,
  );
  assert.equal(
    isProjectionTemporallyCompatible('Backstory: on Day 12, before the current scene.', timeline),
    true,
  );
});

test('timeline prompt block is compact and reports uncertainty without raw chat', () => {
  const timeline = rebuildTimeline(
    [msg('Current story time: Day 15.'), msg('Current story time: Day 12.')],
    { chatId: 'chat-30', epochId: 'epoch-30' },
  );
  const block = buildTimelinePromptBlock(timeline);

  assert.match(block, /Story clock: Day 12/);
  assert.match(block, /temporal conflict/i);
  assert.doesNotMatch(block, /Narrator:/);
});
