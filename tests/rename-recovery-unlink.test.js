import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkNamespace } from '../rename-recovery.js';

test('unlink moves the force-linked target to rollback and leaves source untouched', () => {
  const store = {
    source_old: {
      memories: [{ id: 'source' }],
      archived_alias: 'uid-current',
    },
    'uid-current': {
      chat_uid: 'uid-current',
      chat_id: 'new-chat',
      memories: [{ id: 'imported' }],
    },
  };

  const result = unlinkNamespace(store, 'uid-current', { reason: 'manual-link-undone' });

  assert.equal(result.ok, true);
  assert.equal(store['uid-current'], undefined);
  assert.deepEqual(store.source_old.memories, [{ id: 'source' }]);
  assert.deepEqual(store.archived_chats['uid-current'].container.memories, [{ id: 'imported' }]);
  assert.equal(store.archived_chats['uid-current'].reason, 'manual-link-undone');
});
