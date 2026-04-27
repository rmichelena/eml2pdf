#!/usr/bin/env node
// Manual load test for the byte-bounded queue.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3005 N=100 SIZE_MB=2 node test/load.js
//
// Defaults: 100 concurrent requests of ~2 MB synthetic emails.
// Verifies:
//   - server returns 200 for accepted requests
//   - 503 responses carry Retry-After + X-Queued-Bytes + X-In-Flight-Renders
//   - no individual request hangs forever
//
// You'll want to also watch in another terminal:
//   docker stats eml2pdf
//   docker compose logs -f eml2pdf | jq -c .

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3005';
const N = parseInt(process.env.N || '100', 10);
const SIZE_MB = parseFloat(process.env.SIZE_MB || '2');
const SIZE_BYTES = Math.floor(SIZE_MB * 1024 * 1024);

function makeEml(idx) {
  // Minimal valid RFC 822 message; pad with a long X-Filler header to hit SIZE_BYTES.
  const header =
`From: load-test@example.com
To: dest@example.com
Subject: Load test ${idx}
Date: ${new Date().toUTCString()}
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

<html><body><h1>Load test ${idx}</h1><p>Hello.</p></body></html>
`;
  const padNeeded = Math.max(0, SIZE_BYTES - Buffer.byteLength(header) - 100);
  const filler = `X-Filler: ${'a'.repeat(padNeeded)}\n`;
  return Buffer.from(filler + header, 'utf8');
}

async function fire(idx) {
  const eml = makeEml(idx);
  const body = JSON.stringify({
    emlBase64: eml.toString('base64'),
    options: { timezone: 'UTC' },
  });
  const started = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const ms = Date.now() - started;
    const status = resp.status;
    const headers = {
      retryAfter: resp.headers.get('Retry-After'),
      queuedBytes: resp.headers.get('X-Queued-Bytes'),
      inFlight: resp.headers.get('X-In-Flight-Renders'),
      requestId: resp.headers.get('X-Request-Id'),
    };
    if (status !== 200) {
      const text = await resp.text();
      return { idx, status, ms, headers, error: text.slice(0, 200) };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return { idx, status, ms, headers, zipBytes: buf.length };
  } catch (e) {
    return { idx, status: 'ERR', ms: Date.now() - started, error: e.message };
  }
}

(async () => {
  console.log(`Firing ${N} concurrent requests of ${SIZE_MB} MB to ${BASE_URL}/convert`);
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => fire(i)));
  const totalMs = Date.now() - t0;

  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const byStatus = Object.fromEntries(Object.entries(counts).sort());
  const ok = results.filter(r => r.status === 200);
  const tooMany = results.filter(r => r.status === 503);
  const others = results.filter(r => r.status !== 200 && r.status !== 503);

  const pct = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };
  const oks = ok.map(r => r.ms);

  console.log(JSON.stringify({
    totalMs,
    byStatus,
    okLatency: { p50: pct(oks, 0.5), p90: pct(oks, 0.9), p99: pct(oks, 0.99), max: oks.length ? Math.max(...oks) : 0 },
    sampleBackpressure: tooMany.slice(0, 3).map(r => ({ ms: r.ms, headers: r.headers, error: r.error })),
    sampleOther: others.slice(0, 5),
  }, null, 2));

  // Sanity assertions: nothing hung past 10 minutes
  const stuck = results.filter(r => r.ms > 10 * 60_000);
  if (stuck.length) {
    console.error(`WARN: ${stuck.length} request(s) took > 10 min — possible hang`);
    process.exitCode = 1;
  }
})();
