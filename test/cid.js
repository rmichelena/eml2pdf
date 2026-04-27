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

// HTML references a CID that doesn't exist in attachments → per-cid warning + 0 inline.
{
  const mail = await simpleParser(makeEml('<img src="cid:does-not-exist@example.com">'));
  const warnings = [];
  const { html, inlineCount } = buildHtmlForTest(mail, 'UTC', warnings);
  const cidStillThere = /cid:does-not-exist/.test(html);
  const perCidWarning = warnings.some(w => /Unresolved CID image: does-not-exist@example\.com/.test(w));
  check('unresolved cid: produces a per-cid warning',
    inlineCount === 0 && perCidWarning && cidStillThere,
    { inlineCount, warnings, cidStillThere });
}

// background="cid:..." (legacy Outlook/marketing hero pattern).
{
  const mail = await simpleParser(makeEml('<table background="cid:sig123@example.com"><tr><td>x</td></tr></table>'));
  const warnings = [];
  const { html, inlineCount, usedCids } = buildHtmlForTest(mail, 'UTC', warnings);
  const hasDataUrl = html.includes(`data:image/jpeg;base64,${SIG_B64}`);
  const cidGone = !/background\s*=\s*["']?cid:/i.test(html);
  check('background="cid:..." resolved',
    hasDataUrl && cidGone && inlineCount === 1 && usedCids.has('sig123@example.com') && warnings.length === 0,
    { inlineCount, usedCids: [...usedCids], warnings });
}

// CSS url(cid:...) inside style attribute.
{
  const mail = await simpleParser(makeEml('<div style="background-image:url(cid:sig123@example.com)">x</div>'));
  const warnings = [];
  const { html, inlineCount, usedCids } = buildHtmlForTest(mail, 'UTC', warnings);
  const hasDataUrl = html.includes(`data:image/jpeg;base64,${SIG_B64}`);
  const cidGone = !/url\([^)]*cid:/i.test(html);
  check('CSS url(cid:...) resolved',
    hasDataUrl && cidGone && inlineCount === 1 && usedCids.has('sig123@example.com') && warnings.length === 0,
    { inlineCount, usedCids: [...usedCids], warnings, snippet: html.slice(html.indexOf('<body'), html.indexOf('<body')+300) });
}

// CSS url('cid:...') with single quotes inside style.
{
  const mail = await simpleParser(makeEml(`<div style="background:url('cid:sig123@example.com')">x</div>`));
  const warnings = [];
  const { html, inlineCount } = buildHtmlForTest(mail, 'UTC', warnings);
  const hasDataUrl = html.includes(`data:image/jpeg;base64,${SIG_B64}`);
  check(`CSS url('cid:...') with single quotes resolved`,
    hasDataUrl && inlineCount === 1 && warnings.length === 0,
    { inlineCount, warnings });
}

// =====================================================================
// Pagination CSS regression tests. Outlook/Word and many marketing emails
// ship page-break-* / break-* / @page declarations that, in a single-long-
// page PDF, force unwanted page breaks (typically right before the body,
// after our injected header). The strip should remove every variant.
// =====================================================================

function makePlainHtmlEml(html) {
  return Buffer.from(
`From: a@example.com
Subject: pagination
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

${html}
`,
    'utf8'
  );
}

const PAGINATION_FIXTURES = [
  {
    name: 'Word section pagination in <style> block',
    html: `<html><head><style>
      div.WordSection1 { page: WordSection1; }
      p.first { page-break-before: always; }
      .lead { break-before: page; }
      @page WordSection1 { size: 8.5in 11in; margin: 1in }
    </style></head><body>
      <div class="WordSection1"><p class="first">Hello</p></div>
    </body></html>`,
  },
  {
    name: 'Outlook mso-page-break-before',
    html: `<style>div.section { mso-page-break-before: always; }</style>
           <div class="section">x</div>`,
  },
  {
    name: 'inline style="page-break-before:always"',
    html: `<p style="color:red; page-break-before: always; font-size:14px">x</p>`,
  },
  {
    name: 'inline style="break-before:page" with !important',
    html: `<p style="break-before: page !important; color: red">x</p>`,
  },
  {
    name: '@page rule alone (no name, with margin)',
    html: `<style>@page { size: auto; margin: 1in }</style><p>x</p>`,
  },
];

for (const fx of PAGINATION_FIXTURES) {
  const mail = await simpleParser(makePlainHtmlEml(fx.html));
  const { html } = buildHtmlForTest(mail, 'UTC', []);

  // Slice to the body so we don't false-positive on our own injected <style>.
  const bodyStart = html.indexOf('<body');
  const body = html.slice(bodyStart);

  const noPageBreak = !/\bpage-break-(?:before|after|inside)\s*:/i.test(body);
  const noBreak = !/\bbreak-(?:before|after|inside)\s*:/i.test(body);
  const noPage = !/\bpage\s*:\s*\w/i.test(body);
  const noAtPage = !/@page\b/i.test(body);
  const noMso = !/\bmso-page-break/i.test(body);
  // The user's content survives — we strip pagination, not text content.
  const contentSurvives = /Hello|x/.test(body);

  check(`pagination strip — ${fx.name}`,
    noPageBreak && noBreak && noPage && noAtPage && noMso && contentSurvives,
    { noPageBreak, noBreak, noPage, noAtPage, noMso, contentSurvives,
      bodySnippet: body.slice(0, 600) });
}

// Inline style with mixed declarations: pagination removed, the rest kept.
{
  const mail = await simpleParser(makePlainHtmlEml(
    `<p style="color:red; page-break-before:always; font-size:14px; break-after: page">hi</p>`
  ));
  const { html } = buildHtmlForTest(mail, 'UTC', []);
  const body = html.slice(html.indexOf('<body'));
  const colorKept = /color\s*:\s*red/.test(body);
  const fontSizeKept = /font-size\s*:\s*14px/.test(body);
  const pbGone = !/page-break-before/.test(body);
  const baGone = !/break-after/.test(body);
  check('inline style: kill pagination, keep rest',
    colorKept && fontSizeKept && pbGone && baGone,
    { colorKept, fontSizeKept, pbGone, baGone, body: body.slice(0, 400) });
}

// Document scaffolding: <html>/<head>/<body>/<title>/<meta> from the email
// must NOT survive verbatim inside our outer <body>. <style> from inside
// <head> must survive.
{
  const mail = await simpleParser(makePlainHtmlEml(
    `<html><head><title>SPAM</title><meta http-equiv="refresh" content="0;url=https://evil"><style>.foo{color:red}</style></head><body><p>content</p></body></html>`
  ));
  const { html } = buildHtmlForTest(mail, 'UTC', []);
  const body = html.slice(html.indexOf('<body'));
  // Email's <title> text must not leak into rendered body.
  const noTitleLeak = !/SPAM/.test(body);
  // Email's <meta refresh> dropped.
  const noMeta = !/<meta[^>]*refresh/i.test(body);
  // Email's <style> survived.
  const styleKept = /\.foo\s*\{\s*color\s*:\s*red\s*\}/.test(body);
  // Content kept.
  const contentKept = /content/.test(body);
  check('document scaffolding unwrapped, <style> kept',
    noTitleLeak && noMeta && styleKept && contentKept,
    { noTitleLeak, noMeta, styleKept, contentKept, body: body.slice(0, 600) });
}

if (fail) {
  console.error(`\n${fail} test(s) failed`);
  process.exit(1);
}
console.log('\nAll tests passed');
