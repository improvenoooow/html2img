'use strict';

const net = require('net');

/**
 * Klucz klienta do limitów: IPv4 – pełny adres, IPv6 – prefiks /64.
 * Pojedyncze łącze IPv6 dostaje zwykle całą pulę /64 (2^64 adresów), więc limit "na adres IPv6"
 * dałoby się obejść, zmieniając adres w obrębie własnej sieci.
 */
function clientKey(ip) {
  if (!ip) return 'unknown';
  const addr = String(ip).split('%')[0]; // bez identyfikatora strefy (fe80::1%eth0)
  if (addr.toLowerCase().startsWith('::ffff:') && net.isIPv4(addr.slice(7))) return addr.slice(7);
  if (!net.isIPv6(addr)) return addr;

  let parts = addr.split(':');
  const last = parts[parts.length - 1];
  if (last.includes('.')) {
    // osadzony IPv4 (np. 64:ff9b::192.0.2.1) → dwie grupy szesnastkowe
    const o = last.split('.').map(Number);
    parts = [...parts.slice(0, -1), ((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
  }
  const gap = parts.indexOf('');
  let groups;
  if (gap === -1) groups = parts;
  else {
    const head = parts.slice(0, gap).filter(Boolean);
    const tail = parts.slice(gap + 1).filter(Boolean);
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  }
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

module.exports = { clientKey };
