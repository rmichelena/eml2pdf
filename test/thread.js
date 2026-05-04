// Integration tests for /convert-thread endpoint
// Run with: node /tmp/test-thread-api.mjs

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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

function buildTextEml(opts) {
  const { from, to, subject, date, body } = opts;
  const eml = `From: ${from}
To: ${to}
Subject: ${subject}
Date: ${date}
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

${body}`;
  return Buffer.from(eml).toString('base64url');
}

function buildRelatedEml(opts) {
  const { from, to, subject, date, body, images } = opts;
  const boundary = 'rel_' + Math.random().toString(36).slice(2);
  let eml = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\nMIME-Version: 1.0\nContent-Type: multipart/related; boundary="${boundary}"\n\n--${boundary}\nContent-Type: text/html; charset=utf-8\n\n${body}\n`;
  for (const img of images) {
    eml += `\n--${boundary}\nContent-Type: ${img.contentType || 'image/png'}\nContent-ID: <${img.cid}>\nContent-Transfer-Encoding: base64\nContent-Disposition: inline; filename="${img.name}"\n\n${Buffer.from(img.content).toString('base64')}\n`;
  }
  eml += `\n--${boundary}--`;
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


function extractMd(buf) {
  const tmpZip = `/tmp/test-thread-${Date.now()}.zip`;
  writeFileSync(tmpZip, buf);
  try { return execSync(`unzip -p ${tmpZip} '*thread.md'`).toString(); }
  finally { try { execSync(`rm -f ${tmpZip}`); } catch {} }
}

function listZip(buf) {
  const tmpZip = `/tmp/test-thread-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`;
  writeFileSync(tmpZip, buf);
  try { return execSync(`unzip -Z1 ${tmpZip}`).toString().trim().split('\n').filter(Boolean); }
  finally { try { execSync(`rm -f ${tmpZip}`); } catch {} }
}

// 9. quoteMode strip resolves CIDs after quote removal and does not emit
// images that only existed in the stripped quote as attachments.
{
  const msg = buildRelatedEml({
    from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'CID strip', date: 'Mon, 28 Apr 2025 10:00:00 +0200',
    body: '<p>Current</p><img src="cid:body@x"><blockquote class="gmail_quote"><p>Old</p><img src="cid:quote@x"></blockquote>',
    images: [
      { cid: 'body@x', name: 'body.png', content: 'body-image' },
      { cid: 'quote@x', name: 'quote.png', content: 'quote-image' },
    ],
  });
  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'cid strip: 200');
  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    const names = listZip(buf);
    const md = extractMd(buf);
    assert(md.includes('Current') && !md.includes('Old'), 'cid strip: quoted body removed');
    assert(!names.some(n => /attachments\/(body|quote)\.png$/.test(n)), 'cid strip: inline/removed quote images not emitted as attachments');
  }
}

// 10. Quote strip with Italian locale — reply preserved, quote removed
{
  const msg1 = buildEml({ from: 'A <a@a.it>', to: 'B <b@b.it>', subject: 'Ciao', date: 'Mon, 28 Apr 2025 10:00:00 +0200', body: '<p>Messaggio originale.</p>' });
  const msg2 = buildEml({ from: 'B <b@b.it>', to: 'A <a@a.it>', subject: 'Re: Ciao', date: 'Mon, 28 Apr 2025 10:30:00 +0200', body: '<p>La mia risposta</p><div>Bob ha scritto:</div><div>contenuto vecchio</div>' });

  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg1 }, { rawBase64Url: msg2 }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'IT strip: 200');
  if (res.ok) {
    const md = extractMd(Buffer.from(await res.arrayBuffer()));
    const sec = md.split('## Message 2')[1] || '';
    assert(sec.includes('La mia risposta'), 'IT strip: reply preserved');
    assert(!sec.includes('ha scritto'), 'IT strip: separator removed');
    assert(!sec.includes('contenuto vecchio'), 'IT strip: quoted content removed');
  }
}

// 10. Quote strip with Portuguese locale
{
  const msg1 = buildEml({ from: 'A <a@a.pt>', to: 'B <b@b.pt>', subject: 'Olá', date: 'Mon, 28 Apr 2025 10:00:00 +0200', body: '<p>Mensagem original.</p>' });
  const msg2 = buildEml({ from: 'B <b@b.pt>', to: 'A <a@a.pt>', subject: 'Re: Olá', date: 'Mon, 28 Apr 2025 10:30:00 +0200', body: '<p>Minha resposta</p><div>Bob escreveu:</div><div>antigo</div>' });

  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg1 }, { rawBase64Url: msg2 }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'PT strip: 200');
  if (res.ok) {
    const md = extractMd(Buffer.from(await res.arrayBuffer()));
    const sec = md.split('## Message 2')[1] || '';
    assert(sec.includes('Minha resposta'), 'PT strip: reply preserved');
    assert(!sec.includes('escreveu'), 'PT strip: separator removed');
  }
}

// 11. English “wrote:” in legitimate body text — must NOT strip
{
  const msg = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Notes', date: 'Mon, 28 Apr 2025 10:00:00 +0200', body: '<p>Looking back On the page Sue wrote: meeting notes</p><p>More legit body</p>' });

  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'EN legit wrote: 200');
  if (res.ok) {
    const md = extractMd(Buffer.from(await res.arrayBuffer()));
    assert(md.includes('Looking back'), 'EN legit: body preserved');
    assert(md.includes('More legit body'), 'EN legit: second paragraph preserved');
  }
}

// 12. English real quote separator — should strip
{
  const msg1 = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Meet', date: 'Mon, 28 Apr 2025 10:00:00 +0200', body: '<p>Lets meet Tuesday.</p>' });
  const msg2 = buildEml({ from: 'B <b@b.com>', to: 'A <a@a.com>', subject: 'Re: Meet', date: 'Mon, 28 Apr 2025 10:30:00 +0200', body: '<p>Sounds good!</p><div>On Mon, Apr 28, 2025 at 10:00 AM, A wrote:</div><div>Lets meet Tuesday.</div>' });

  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg1 }, { rawBase64Url: msg2 }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'EN real quote: 200');
  if (res.ok) {
    const md = extractMd(Buffer.from(await res.arrayBuffer()));
    const sec = md.split('## Message 2')[1] || '';
    assert(sec.includes('Sounds good'), 'EN real quote: reply preserved');
    assert(!sec.includes('On Mon, Apr 28'), 'EN real quote: separator stripped');
  }
}

// 13. text/plain quoteMode strip removes > quote lines from Markdown
{
  const msg = buildTextEml({
    from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Plain',
    date: 'Mon, 28 Apr 2025 10:00:00 +0200',
    body: 'Fresh reply line\n\n> Old quoted line\n> Another old line',
  });

  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'text/plain strip: 200');
  if (res.ok) {
    const md = extractMd(Buffer.from(await res.arrayBuffer()));
    assert(md.includes('Fresh reply line'), 'text/plain strip: reply preserved');
    assert(!md.includes('Old quoted line'), 'text/plain strip: quoted line removed');
  }
}

// 14. threadId is sanitized before JSON metadata
{
  const msg = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Thread id', date: 'Mon, 28 Apr 2025 10:00:00 +0200', body: '<p>Hi</p>' });
  const res = await post('/convert-thread', {
    threadId: '../bad/id',
    messages: [{ rawBase64Url: msg }],
    options: { outputs: ['markdown'] },
  });
  assertEqual(res.status, 200, 'threadId sanitize: 200');
  if (res.ok) {
    const tmpZip = `/tmp/test-thread-json-${Date.now()}.zip`;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpZip, buf);
    try {
      const json = JSON.parse(execSync(`unzip -p ${tmpZip} '*thread.json'`).toString());
      assert(json.threadId === '__bad_id', 'threadId sanitize: metadata sanitized');
    } finally { try { execSync(`rm -f ${tmpZip}`); } catch {} }
  }
}

// 15. Parallel gmail_quote blocks do not delete legitimate content between them
{
  const msg = buildEml({
    from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Parallel quotes',
    date: 'Mon, 28 Apr 2025 10:00:00 +0200',
    body: '<p>Reply start</p><blockquote class="gmail_quote"><p>old one</p></blockquote><p>Legitimate middle content</p><blockquote class="gmail_quote"><p>old two</p></blockquote><p>Reply end</p>',
  });

  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'parallel gmail_quote: 200');
  if (res.ok) {
    const md = extractMd(Buffer.from(await res.arrayBuffer()));
    assert(md.includes('Reply start'), 'parallel gmail_quote: start preserved');
    assert(md.includes('Legitimate middle content'), 'parallel gmail_quote: middle preserved');
    assert(md.includes('Reply end'), 'parallel gmail_quote: end preserved');
    assert(!md.includes('old one'), 'parallel gmail_quote: first quote removed');
    assert(!md.includes('old two'), 'parallel gmail_quote: second quote removed');
  }
}

// 16. Invalid quoteMode returns 400 instead of silently preserving quotes
{
  const msg = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Bad mode', date: 'Mon, 28 Apr 2025 10:00:00 +0200', body: '<p>Hi</p>' });
  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg }],
    options: { outputs: ['markdown'], quoteMode: 'strp' },
  });
  assertEqual(res.status, 400, 'invalid quoteMode: 400');
}

// 17. Residual layout-table HTML in signatures is degraded to readable Markdown text
{
  const signature = '<table border="0"><tbody><tr><td><img><br></td><td><table><tbody><tr><td><span id="name">Roberto Michelena</span><span>&nbsp;|&nbsp;</span><span>Gerente General</span><br><span>CONSORCIO INFINITEK-GOALS</span><br><span>Cel +51 992784344</span></td></tr><tr><td><a href="mailto:roberto@infinitek.pe">email</a><span>&nbsp;|&nbsp;</span><a href="https://wa.me/51992784344">whatsapp</a></td></tr></tbody></table></td></tr></tbody></table>';
  const msg = buildEml({ from: 'A <a@a.com>', to: 'B <b@b.com>', subject: 'Signature', date: 'Mon, 28 Apr 2025 10:00:00 +0200', body: `<p>Saludos,</p>${signature}` });
  const res = await post('/convert-thread', {
    messages: [{ rawBase64Url: msg }],
    options: { outputs: ['markdown'], quoteMode: 'strip' },
  });
  assertEqual(res.status, 200, 'signature table markdown: 200');
  if (res.ok) {
    const md = extractMd(Buffer.from(await res.arrayBuffer()));
    assert(md.includes('Roberto Michelena'), 'signature table markdown: text preserved');
    assert(md.includes('mailto:roberto@infinitek.pe'), 'signature table markdown: link preserved');
    assert(!/<table|<tbody|<tr|<td|<span/i.test(md), 'signature table markdown: no raw layout HTML');
  }
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
