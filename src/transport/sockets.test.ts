import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peerClose } from './sockets.ts';

test('a peer gets 1 s to close its end before its socket is reset', () => {
  assert.equal(peerClose.waitMs, 1000);
});
