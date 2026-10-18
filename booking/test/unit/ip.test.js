'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clientKey } = require('../../src/lib/ip');

test('IPv4 i IPv4 mapowany na IPv6 → pełny adres', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey(undefined), 'unknown');
});

test('IPv6 → prefiks /64 (adresy z jednej sieci mają wspólny limit)', () => {
  const a = clientKey('2a02:a311:4300:1a00:1111:2222:3333:4444');
  const b = clientKey('2a02:a311:4300:1a00:dead:beef:0:1');
  assert.equal(a, '2a02:a311:4300:1a00::/64');
  assert.equal(a, b);
  assert.notEqual(a, clientKey('2a02:a311:4300:1a01::1'));
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('2001:DB8:0000:0000::abcd'), '2001:db8:0:0::/64');
  assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
});
