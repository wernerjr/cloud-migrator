'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transferErrorText } = require('../lib/engine');

const deny =
  "Couldn't delete: googleapi: Error 403: The user does not have sufficient permissions for this file., insufficientFilePermissions";

test('source delete permission errors explain that files remain', () => {
  const text = transferErrorText({
    errors: [deny],
    lastStats: { lastError: 'not deleting directories as there were IO errors' },
    stderrTail: '',
  });
  assert.match(text, /não tem permissão para excluir/);
  assert.ok(text.includes(deny));
});

test('other failures keep only the rclone details', () => {
  assert.equal(
    transferErrorText({ errors: ['falha de rede'], lastStats: null, stderrTail: '' }),
    'falha de rede',
  );
});
