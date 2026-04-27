#!/usr/bin/env node
// Unit tests for inline CID resolution and the inline-vs-attachment decision.
// Does NOT touch Playwright — exercises buildHtml directly.
//
// Regression target: in v1.1.0 of this PR, signatures embedded as multipart/
// related image/jpeg with Content-ID references were rendering as separate
// `attachments/*.jpg` files instead of being inlined into the PDF.
//
// Run: node test/cid.js

import { simpleParser } from 'mailparser';
import { buildHtmlForTest } from '../src/convert.js';

const SIG_BYTES = Buffer.from('aGVsbG8gd29ybGQ=', 'base64'); // arbitrary blob
const SIG_B64 = SIG_BYTES.toString('base64');

function makeEml(html, contentId = '<sig123@example.com>') {
  return Buffer.from(
`From: a@example.com
To: b@example.com
Subject: CID test
MIME-Version: 1.0
Content-Type: multipart/related; boundary="BOUND"

--BOUND
Content-Type: text/html; charset=utf-8

${html}

--BOUND
Content-Type: image/jpeg
Content-ID: ${contentId}
Content-Transfer-Encoding: base64
Content-Disposition: inline; filename="signature.jpg"

${SIG_B64}

--BOUND--
`,
    'utf8'
  );
}

let fail = 0;
function check(label, cond, ctx = {}) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    fail++;
    for (const [k, v] of Object.entries(ctx)) console.log(`  ${k}=`, v);
  }
}

// Each of these should result in the signature image being rendered inline
// in the PDF (data: URL in HTML), inlineCount=1, no warnings, and (downstream)
// the JPG NOT showing up as an attachment.
const FIXTURES = [
  { name: 'standard double-quoted src',         html: `<p>hi</p><img src="cid:sig123@example.com"><p>bye</p>` },
  { name: 'single-quoted src',                  html: `<img src='cid:sig123@example.com'>` },
  { name: 'unquoted src',                       html: `<img src=cid:sig123@example.com>` },
  { name: 'whitespace around equals',           html: `<img src = "cid:sig123@example.com">` },
  { name: 'mixed casing in CID reference',      html: `<img src="cid:SIG123@Example.com">` },
  { name: 'attribute order with id first',      html: `<img id="sig" src="cid:sig123@example.com" alt="sig">` },
];

for (const fx of FIXTURES) {
  const mail = await simpleParser(makeEml(fx.html));
  const warnings = [];
  const { html, inlineCount, usedCids } = buildHtmlForTest(mail, 'UTC', warnings);

  const hasDataUrl = html.includes(`data:image/jpeg;base64,${SIG_B64}`);
  const cidGone = !/\bsrc\s*=\s*["']?\s*cid:/i.test(html);
  const oneInlined = inlineCount === 1;
  const trackedCid = usedCids.has('sig123@example.com');
  const noWarnings = warnings.length === 0;

  check(fx.name, hasDataUrl && cidGone && oneInlined && trackedCid && noWarnings, {
    inlineCount, usedCids: [...usedCids], warnings,
    cidLeft: !cidGone, snippet: html.slice(html.indexOf('<body'), html.indexOf('<body') + 200),
  });
}

// Two distinct CID images, both referenced.
{
  const eml = Buffer.from(
`From: a@x.com
Subject: t
MIME-Version: 1.0
Content-Type: multipart/related; boundary="B"

--B
Content-Type: text/html

<img src="cid:one@x"><img src="cid:two@x">

--B
Content-Type: image/png
Content-ID: <one@x>
Content-Transfer-Encoding: base64

${SIG_B64}

--B
Content-Type: image/png
Content-ID: <two@x>
Content-Transfer-Encoding: base64

${SIG_B64}

--B--
`, 'utf8');
  const mail = await simpleParser(eml);
  const warnings = [];
  const { inlineCount, usedCids } = buildHtmlForTest(mail, 'UTC', warnings);
  check('two CIDs, both referenced', inlineCount === 2 && usedCids.has('one@x') && usedCids.has('two@x') && warnings.length === 0, { inlineCount, usedCids: [...usedCids], warnings });
}

// CID present as attachment but NOT referenced anywhere in HTML.
// Should: inlineCount=0, usedCids empty, no warning, AND extractAttachments
// (tested implicitly: usedCids empty means it WILL be emitted as attachment).
{
  const mail = await simpleParser(makeEml('<p>no image here</p>'));
  const warnings = [];
  const { inlineCount, usedCids } = buildHtmlForTest(mail, 'UTC', warnings);
  check('unreferenced CID stays out of usedCids',
    inlineCount === 0 && usedCids.size === 0 && warnings.length === 0,
    { inlineCount, usedCids: [...usedCids], warnings });
}

// HTML references a CID that doesn't exist in attachments → warning + 0 inline.
{
  const mail = await simpleParser(makeEml('<img src="cid:does-not-exist@example.com">'));
  const warnings = [];
  const { html, inlineCount } = buildHtmlForTest(mail, 'UTC', warnings);
  const cidStillThere = /cid:does-not-exist/.test(html);
  check('unresolved cid: produces a warning',
    inlineCount === 0 && warnings.some(w => /CID/i.test(w)) && cidStillThere,
    { inlineCount, warnings, cidStillThere });
}

if (fail) {
  console.error(`\n${fail} test(s) failed`);
  process.exit(1);
}
console.log('\nAll CID tests passed');
