#!/usr/bin/env node
// Unit tests for the markdown output path. Does NOT touch Playwright or
// the PDF pipeline — exercises buildHtml + buildMarkdown directly.
//
// Run: node test/markdown.js

import { simpleParser } from 'mailparser';
import { buildHtmlForTest } from '../src/convert.js';
import { buildMarkdown } from '../src/markdown.js';

const SIG_BYTES = Buffer.from('aGVsbG8gd29ybGQ=', 'base64');
const SIG_B64 = SIG_BYTES.toString('base64');

function eml(bodyHtml, extra = '') {
  return Buffer.from(
`From: Alice <alice@example.com>
To: Bob <bob@example.com>
Subject: Quarterly Report
Date: Wed, 15 Jan 2025 08:30:00 +0000
MIME-Version: 1.0
Content-Type: multipart/related; boundary="B"

--B
Content-Type: text/html; charset=utf-8

${bodyHtml}

${extra}
--B
Content-Type: image/jpeg
Content-ID: <sig@example>
Content-Transfer-Encoding: base64
Content-Disposition: inline; filename="signature.jpg"

${SIG_B64}

--B--
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

async function buildBoth(emlBuf) {
  const mail = await simpleParser(emlBuf);
  const warnings = [];
  const { body, inlineCount, usedCids } = buildHtmlForTest(mail, 'UTC', warnings);
  const metadata = {
    messageId: mail.messageId,
    subject: mail.subject || '',
    from: mail.from?.text || '',
    to: (mail.to?.value || []).map(a => a.text || a.address),
    cc: (mail.cc?.value || []).map(a => a.text || a.address),
    date: mail.date ? mail.date.toISOString() : null,
    timezone: 'UTC',
    inlineImagesResolved: inlineCount,
    attachments: [],
    warnings,
  };
  const md = buildMarkdown(mail, body, metadata);
  return { md, metadata, usedCids };
}

// 1. Headers + simple body.
{
  const { md } = await buildBoth(eml(`<p>Hello <b>world</b>.</p>`));
  const hasH1 = /^# Quarterly Report/m.test(md);
  const hasFrom = /\*\*From:\*\*[^\n]*alice@example\.com/.test(md);
  const hasTo = /\*\*To:\*\*[^\n]*bob@example\.com/.test(md);
  const hasDate = /\*\*Date:\*\* 2025-01-15T08:30:00\.000Z/.test(md);
  const hasBold = /\*\*world\*\*/.test(md);
  const noHtml = !/<p>|<b>/i.test(md);
  check('basic headers + bold body',
    hasH1 && hasFrom && hasTo && hasDate && hasBold && noHtml,
    { hasH1, hasFrom, hasTo, hasDate, hasBold, noHtml, md: md.slice(0, 400) });
}

// 2. Inline image (cid:) → markdown image with data URL.
{
  const { md, metadata } = await buildBoth(eml(
    `<p>See signature:</p><img src="cid:sig@example" alt="Signature">`
  ));
  // Only check the prefix of the data URL — full payload too long for grep.
  const hasImageMd = /!\[Signature\]\(data:image\/jpeg;base64,/.test(md);
  const inlineCounted = metadata.inlineImagesResolved === 1;
  check('inline cid image → ![alt](data:...) in markdown',
    hasImageMd && inlineCounted,
    { hasImageMd, inlineCounted, snippet: md.slice(md.indexOf('See sign'), md.indexOf('See sign') + 200) });
}

// 3. Tables — GFM markdown table from <table>.
{
  const { md } = await buildBoth(eml(
    `<table>
      <thead><tr><th>Name</th><th>Score</th></tr></thead>
      <tbody>
        <tr><td>Alice</td><td>90</td></tr>
        <tr><td>Bob</td><td>85</td></tr>
      </tbody>
    </table>`
  ));
  const hasGfmTable = /\|\s*Name\s*\|\s*Score\s*\|/.test(md) && /\|\s*Alice\s*\|\s*90\s*\|/.test(md);
  check('HTML table → GFM markdown table',
    hasGfmTable,
    { snippet: md.slice(md.indexOf('Name')) });
}

// 4. Lists & links.
{
  const { md } = await buildBoth(eml(
    `<ul><li>One</li><li>Two</li></ul>
     <p>Visit <a href="https://example.com">site</a></p>`
  ));
  const hasUl = /^-\s+One$/m.test(md) && /^-\s+Two$/m.test(md);
  const hasLink = /\[site\]\(https:\/\/example\.com\)/.test(md);
  check('lists + links', hasUl && hasLink, { hasUl, hasLink, snippet: md.slice(-300) });
}

// 5. <style> blocks must not leak into the markdown.
{
  const { md } = await buildBoth(eml(
    `<style>p{color:red}</style><p>visible</p>`
  ));
  const noStyle = !/color\s*:\s*red/.test(md) && !/<style/i.test(md);
  const bodyKept = /visible/.test(md);
  check('<style> blocks dropped, body kept',
    noStyle && bodyKept,
    { noStyle, bodyKept, md: md.slice(-300) });
}

// 6. Attachments section appears when metadata has attachments.
{
  const mail = await simpleParser(eml('<p>x</p>'));
  const warnings = [];
  const { body } = buildHtmlForTest(mail, 'UTC', warnings);
  const metadata = {
    subject: 'Quarterly Report',
    from: 'a@x', to: ['b@x'], cc: [], date: null, timezone: 'UTC',
    inlineImagesResolved: 0,
    attachments: [
      { filename: 'report.pdf', contentType: 'application/pdf', size: 12345, inline: false },
      { filename: 'photo.jpg', contentType: 'image/jpeg', size: 4096, inline: false },
    ],
    warnings,
  };
  const md = buildMarkdown(mail, body, metadata);
  const hasSection = /## Attachments/.test(md);
  const hasReport = /`report\.pdf` — application\/pdf \(12\.1 KB\)/.test(md);
  const hasPhoto = /`photo\.jpg` — image\/jpeg \(4\.0 KB\)/.test(md);
  check('attachments section listed',
    hasSection && hasReport && hasPhoto,
    { hasSection, hasReport, hasPhoto, tail: md.slice(-400) });
}

// 7. Warnings section appears when warnings array is non-empty.
{
  const mail = await simpleParser(eml('<p>x</p>'));
  const { body } = buildHtmlForTest(mail, 'UTC', []);
  const metadata = {
    subject: 's', from: '', to: [], cc: [], date: null, timezone: 'UTC',
    inlineImagesResolved: 0, attachments: [],
    warnings: ['Unresolved CID image: foo@bar', 'Blocked 1 remote resource host(s) — …: x.com'],
  };
  const md = buildMarkdown(mail, body, metadata);
  const hasSection = /## Conversion warnings/.test(md);
  const hasW1 = /Unresolved CID image: foo@bar/.test(md);
  const hasW2 = /Blocked 1 remote resource/.test(md);
  check('warnings section listed', hasSection && hasW1 && hasW2,
    { hasSection, hasW1, hasW2 });
}

// 8. Empty / no-body email doesn't crash.
{
  const emptyEml = Buffer.from(
`From: a@x.com
To: b@x.com
Subject: empty
Date: Wed, 15 Jan 2025 08:30:00 +0000
MIME-Version: 1.0
Content-Type: text/plain

`, 'utf8');
  const mail = await simpleParser(emptyEml);
  const { body } = buildHtmlForTest(mail, 'UTC', []);
  const md = buildMarkdown(mail, body, {
    subject: mail.subject, from: '', to: [], cc: [], date: null, timezone: 'UTC',
    inlineImagesResolved: 0, attachments: [], warnings: [],
  });
  check('empty body doesn\'t crash', typeof md === 'string' && md.length > 0, { md });
}

if (fail) {
  console.error(`\n${fail} test(s) failed`);
  process.exit(1);
}
console.log('\nAll markdown tests passed');
