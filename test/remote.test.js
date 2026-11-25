'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBaseUrl } = require('../lib/remote');

test('server URLs are normalized and restricted to http(s)', () => {
  assert.equal(normalizeBaseUrl('http://homelab:8787/'), 'http://homelab:8787');
  assert.equal(normalizeBaseUrl(' https://cm.example.com/base/ '), 'https://cm.example.com/base');
  assert.throws(() => normalizeBaseUrl(''), /Informe a URL/);
  assert.throws(() => normalizeBaseUrl('não é uma url'), /inválida/);
  assert.throws(() => normalizeBaseUrl('homelab:8787'), /http ou https/);
  assert.throws(() => normalizeBaseUrl('ftp://homelab:8787'), /http ou https/);
  assert.throws(() => normalizeBaseUrl('http://user:pass@homelab:8787'), /usuário ou senha/);
});
