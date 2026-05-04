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

async function buildBody(emlBuf) {
  const mail = await simpleParser(emlBuf);
  const warnings = [];
  const { body } = buildHtmlForTest(mail, 'UTC', warnings);
  return { body, warnings };
}

// 1. YAML frontmatter + H1 + simple body.
{
  const { md } = await buildBoth(eml(`<p>Hello <b>world</b>.</p>`));
  // Metadata is emitted as YAML frontmatter (between two --- lines), not
  // inline **bold** text — that's the P3 fix to prevent markdown injection
  // via attacker-controlled subject / message-id / etc.
  const hasFrontmatter = /^---\n[\s\S]*?\n---\n/m.test(md);
  const hasSubjectInFm = /^subject:\s*"Quarterly Report"$/m.test(md);
  const hasFromInFm = /^from:\s*".*alice@example\.com.*"$/m.test(md);
  const hasToInFm = /^to:\s*\[[\s\S]*bob@example\.com[\s\S]*\]$/m.test(md);
  const hasH1 = /^# Quarterly Report/m.test(md);
  const hasBold = /\*\*world\*\*/.test(md);
  const noHtml = !/<p>|<b>/i.test(md);
  check('frontmatter + H1 + bold body',
    hasFrontmatter && hasSubjectInFm && hasFromInFm && hasToInFm && hasH1 && hasBold && noHtml,
    { hasFrontmatter, hasSubjectInFm, hasFromInFm, hasToInFm, hasH1, hasBold, noHtml,
      md: md.slice(0, 500) });
}

// 1b. Markdown injection via subject / message-id / from is neutralized.
{
  const mail = await simpleParser(eml('<p>safe body</p>'));
  const { body } = buildHtmlForTest(mail, 'UTC', []);
  const malicious = {
    messageId: '<a@b>\n# INJECTED-MID\n',
    subject: '\n\n# PWNED-SUBJ\n## Subheading\n[click](javascript:x)',
    from: 'Alice\n# INJECTED-FROM',
    to: ['bob@x'],
    cc: [],
    date: '2025-01-15T08:30:00.000Z',
    timezone: 'UTC',
    inlineImagesResolved: 0,
    attachments: [],
    warnings: [],
  };
  const md = buildMarkdown(mail, body, malicious);
  // No "# PWNED-SUBJ" line appears as a real heading anywhere in the doc.
  // (Markdown headings need to be at the start of a line — `^# text`.)
  // The escaped form `# \# PWNED-SUBJ` is fine: the leading `# ` is from
  // OUR H1, and the `\#` is the escaped attacker hash, which renders as a
  // visible "#" rather than promoting to a sub-heading.
  const noPwnedHeading = !/^# PWNED-SUBJ/m.test(md);
  const noInjectedMid = !/^# INJECTED-MID/m.test(md);
  const noInjectedFrom = !/^# INJECTED-FROM/m.test(md);
  // Subhheading from the subject must not become an H2.
  const noInjectedH2 = !/^## Subheading/m.test(md);
  // The subject text IS still present (escaped) — we don't drop content,
  // we neutralize formatting.
  const subjectStillPresent = /PWNED-SUBJ/.test(md);
  check('markdown injection via metadata neutralized',
    noPwnedHeading && noInjectedMid && noInjectedFrom && noInjectedH2 && subjectStillPresent,
    { noPwnedHeading, noInjectedMid, noInjectedFrom, noInjectedH2, subjectStillPresent,
      head: md.slice(0, 800) });
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

// 9. Outlook Web App loader overlays are stripped so they cannot blank PDFs.
{
  const { body } = await buildBody(eml(`
    <style>
      #loadingScreen { position: fixed; inset: 0; background-color: #fff; }
    </style>
    <div id="loadingScreen"><div id="loadingLogo"><img id="MSLogo"></div></div>
    <p>Visible message body</p>
  `));
  check('OWA loadingScreen node stripped', !/id=["']loadingScreen["']/i.test(body), { body });
  check('OWA loadingLogo node stripped', !/id=["']loadingLogo["']/i.test(body), { body });
  check('OWA MSLogo node stripped', !/id=["']MSLogo["']/i.test(body), { body });
  check('OWA message content preserved', body.includes('Visible message body'), { body });
}

if (fail) {
  console.error(`\n${fail} test(s) failed`);
  process.exit(1);
}
console.log('\nAll markdown tests passed');
