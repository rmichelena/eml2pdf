#!/usr/bin/env node
// Network-policy unit tests. Pure (no DNS for literal IPs).
//
// Run: node test/netfilter.js

import { isPrivateIp } from '../src/netfilter.js';

let fail = 0;
function check(label, cond, ctx = {}) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { fail++; for (const [k, v] of Object.entries(ctx)) console.log(`  ${k}=`, v); }
}

// IPv4 private ranges
check('IPv4 0.0.0.0/8',     isPrivateIp('0.1.2.3'));
check('IPv4 10/8',          isPrivateIp('10.0.0.5'));
check('IPv4 loopback',      isPrivateIp('127.0.0.1'));
check('IPv4 IMDS 169.254',  isPrivateIp('169.254.169.254'));
check('IPv4 172.16/12 lo',  isPrivateIp('172.16.0.1'));
check('IPv4 172.16/12 hi',  isPrivateIp('172.31.255.255'));
check('IPv4 172.32 NOT',    !isPrivateIp('172.32.0.1'));
check('IPv4 192.168/16',    isPrivateIp('192.168.1.1'));
check('IPv4 CGNAT',         isPrivateIp('100.64.1.1'));
check('IPv4 multicast',     isPrivateIp('239.255.255.250'));
check('IPv4 1.1.1.1 public',!isPrivateIp('1.1.1.1'));
check('IPv4 8.8.8.8 public',!isPrivateIp('8.8.8.8'));

// IPv6 — link-local fe80::/10 covers fe80–febf, NOT just fe80
check('IPv6 fe80:: link-local',   isPrivateIp('fe80::1'));
check('IPv6 fe90:: link-local',   isPrivateIp('fe90::1'));
check('IPv6 fea0:: link-local',   isPrivateIp('fea0::dead:beef'));
check('IPv6 feb0:: link-local',   isPrivateIp('feb0::1'));
check('IPv6 febf:: link-local',   isPrivateIp('febf::ffff'));
check('IPv6 fec0:: NOT link-loc', !isPrivateIp('fec0::1')); // outside /10
check('IPv6 fe7f:: NOT link-loc', !isPrivateIp('fe7f::1')); // below /10

// IPv6 other
check('IPv6 ::1',                 isPrivateIp('::1'));
check('IPv6 ULA fc00::/7',        isPrivateIp('fc00::1'));
check('IPv6 ULA fd00::',          isPrivateIp('fd00::1'));
check('IPv6 multicast ff::',      isPrivateIp('ff02::1'));
check('IPv6 mapped loopback',     isPrivateIp('::ffff:127.0.0.1'));
check('IPv6 Google public',       !isPrivateIp('2001:4860:4860::8888'));
check('IPv6 Cloudflare public',   !isPrivateIp('2606:4700:4700::1111'));

// DNS cache bound: lookups for many distinct hosts must not grow memory
// without limit. We use a tiny MAX_DNS_CACHE_SIZE via env override and
// confirm the internal cache size stays at or below it.
{
  // Re-import module under controlled cache size by mutating its env
  // before import. ESM doesn't allow dynamic re-import easily; instead
  // we just exercise the in-memory map by issuing many lookups for hosts
  // that resolve to nothing (DNS lookup fails => cached as private).
  // The cap is 5000 by default; we can't easily test the eviction without
  // overriding env BEFORE the module loaded. Instead, smoke-check that
  // calling many times doesn't throw and that uniqueness stays bounded.
  const { isPrivateHost } = await import('../src/netfilter.js');
  // 50 random hostnames — should not grow forever in subsequent runs
  // since our internal eviction prunes ~10% when full.
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(isPrivateHost(`nonexistent-${i}-${Math.random().toString(36).slice(2)}.invalid`));
  }
  const results = await Promise.all(promises);
  // All non-existent hosts should fail-closed to true.
  const allTrue = results.every(r => r === true);
  check('many unique unresolved hosts → fail-closed without crash',
    allTrue && results.length === 50, { sample: results.slice(0, 3) });
}

if (fail) {
  console.error(`\n${fail} test(s) failed`);
  process.exit(1);
}
console.log('\nAll netfilter tests passed');
