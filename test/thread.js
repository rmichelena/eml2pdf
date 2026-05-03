// Integration tests for /convert-thread endpoint
// Run with: node /tmp/test-thread-api.mjs

const BASE = 'http://localhost:3005';
let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function assertEqual(actual, expected, msg) {
  if (actual === expected) { passed++; }
  else { failed++; console.error(`  ✗ ${msg} (expected ${expected}, got ${actual})`); }
}

function buildEml(opts) {
  const { from, to, subject, date, body, attachment } = opts;
  let eml = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\nMIME-Version: 1.0\n`;
  if (attachment) {
    const boundary = 'b_' + Math.random().toString(36).slice(2);
    eml += `Content-Type: multipart/mixed; boundary="${boundary}"\n\n--${boundary}\nContent-Type: text/html; charset=utf-8\n\n${body}\n\n--${boundary}\nContent-Type: text/plain; name="${attachment.name}"\nContent-Disposition: attachment; filename="${attachment.name}"\n\n${attachment.content}\n--${boundary}--`;
  } else {
    eml += `Content-Type: text/html; charset=utf-8\n\n${body}`;
  }
  return Buffer.from(eml).toString('base64url');
}

async function post(endpoint, body) {
  return fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Check server
const health = await fetch(`${BASE}/health`);
if (!health.ok) { console.error('Server not up'); process.exit(1); }
console.log('Server OK\n');

console.log('=== /convert-thread tests ===\n');

// 1. Basic 2-message thread, PDF + Markdown, quoteMode: preserve
{
  const msg1 = buildEml({ from: 'Alice <alice@example.com>', to: 'Bob <bob@example.com>', subject: 'Project update', date: 'Mon, 28 Apr 2025 10:00:00 +0200', body: '<p>Hey Bob, here is the project update.</p>' });
  const msg2 = buildEml({ from: 'Bob <bob@example.com>', to: 'Alice <alice@example.com>', subject: 'Re: Project update', date: 'Mon, 28 Apr 2025 11:30:00 +0200', body: '<p>Thanks Alice!</p><blockquote class="gmail_quote"><p>Hey Bob, here is the project update.</p></blockquote>' });

  const res = await post('/convert-thread', {
    threadId: 'thread123',
    messages: [{ rawBase64Url: msg1, messageId: 'msg1' }, { rawBase64Url: msg2, messageId: 'msg2' }],
    options: { timezone: 'Europe/Berlin', outputs: ['pdf', 'markdown'], quoteMode: 'preserve' },
  });
  assertEqual(res.status, 200, 'basic thread: 200');
  assert(res.headers.get('content-type') === 'application/zip', 'basic thread: zip content-type');
  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf[0] === 0x50 && buf[1] === 0x4B, 'basic thread: ZIP magic');
    console.log(`  ZIP size: ${buf.length} bytes`);
  }
}

// 2. Quote strip mode, markdown only
{
  const msg1 = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Hello', date: 'Mon, 28 Apr 2025 14:00:00 +0200', body: '<p>Original point.</p>' });
  const msg2 = buildEml({ from: 'B <b@b.com>', to: 'A <a@a.com>', subject: 'Re: Hello', date: 'Mon, 28 Apr 2025 14:30:00 +0200', body: '<p>I agree!</p><blockquote class="gmail_quote"><p>Original point.</p></blockquote>' });

  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg1 }, { rawBase64Url: msg2 }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'strip quotes: 200');
}

// 3. Thread with attachments
{
  const msg1 = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Files', date: 'Mon, 28 Apr 2025 16:00:00 +0200', body: '<p>See attached.</p>', attachment: { name: 'report.txt', content: 'Report data.' } });
  const msg2 = buildEml({ from: 'B <b@b.com>', to: 'A <a@a.com>', subject: 'Re: Files', date: 'Mon, 28 Apr 2025 16:15:00 +0200', body: '<p>Got it!</p>', attachment: { name: 'reply.txt', content: 'Notes.' } });

  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg1 }, { rawBase64Url: msg2 }],
    options: { outputs: ['pdf'] },
  });
  assertEqual(res.status, 200, 'attachments: 200');
  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf.length > 500, 'attachments: ZIP > 500 bytes');
  }
}

// 4. Single message
{
  const msg = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Solo', date: 'Mon, 28 Apr 2025 18:00:00 +0200', body: '<p>Just one.</p>' });
  const res = await post('/convert-thread', { messages: [{ rawBase64Url: msg }], options: { outputs: ['markdown'] } });
  assertEqual(res.status, 200, 'single msg: 200');
}

// 5. Empty messages → 400
{
  const res = await post('/convert-thread', { messages: [] });
  assertEqual(res.status, 400, 'empty messages: 400');
}

// 6. Missing payload → 400
{
  const res = await post('/convert-thread', { messages: [{ messageId: 'msg1' }] });
  assertEqual(res.status, 400, 'no payload: 400');
}

// 7. Invalid output → 400
{
  const msg = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'T', date: 'Mon, 28 Apr 2025 18:00:00 +0200', body: '<p>Hi</p>' });
  const res = await post('/convert-thread', { messages: [{ rawBase64Url: msg }], options: { outputs: ['pdf', 'docx'] } });
  assertEqual(res.status, 400, 'invalid output: 400');
}

// 8. /convert still works (regression check)
{
  const eml = 'From: A <a@a.com>\nTo: B <b@b.com>\nSubject: Test\nDate: Mon, 28 Apr 2025 18:00:00 +0200\nMIME-Version: 1.0\nContent-Type: text/html; charset=utf-8\n\n<p>Hello</p>';
  const res = await post('/convert', { rawBase64Url: Buffer.from(eml).toString('base64url') });
  assertEqual(res.status, 200, '/convert regression: 200');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
