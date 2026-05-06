// Thread conversion: accepts multiple raw emails belonging to the same
// Gmail thread and produces a unified PDF, Markdown, JSON + attachments ZIP.
//
// Design:
//   - Each message is parsed independently.
//   - Messages are sorted chronologically (by internalDate or Date header).
//   - quoteMode: "strip" removes known quote blocks (gmail_quote, blockquote[type=cite])
//     from each message body before concatenation.
//   - quoteMode: "preserve" keeps everything as-is (forensic mode).
//   - Attachments are deduplicated by filename (first occurrence wins, subsequent get suffix).
//   - PDF: one long page with visual separators between messages.
//   - Markdown: YAML frontmatter for the thread + one section per message.
//   - JSON: thread-level metadata + per-message details.

import { simpleParser } from 'mailparser';
import archiver from 'archiver';
import sanitizeHtml from 'sanitize-html';
import { getTurndownService, mdEscapeInline, formatBytes, formatTimestampStem, formatDateSuffix, normalizeResidualHtml } from './textutil.js';

import {
  buildHtmlForTest as buildSingleHtml,
  filterRemoteUrlsForTest as filterRemoteUrls,
  EMAIL_RENDER_CSP,
  EMAIL_RENDER_DEFENSIVE_CSS,
  EMAIL_ALLOWED_TAGS,
  EMAIL_ALLOWED_ATTRS,
  formatDisplayDate,
  resolveCidImages,
  extractCidRefs,
  extractAttachments,
  attachmentListHtml,
  escapeHtml,
  sanitizeFilename,
  renderPdf,
} from './convert.js';

// ─── Quote stripping ─────────────────────────────────────────────────

// Separators Gmail/Outlook/etc. insert before quoted text. Shared by HTML
// and text/plain stripping so language coverage stays consistent.
const QUOTE_SEPARATOR_PATTERNS = [
  /^On .{1,120}? (?:wrote|schrieb|escribi[oó]|a écrit|ha scritto|escreveu)\s*:\s*$/i,  // English/German/Spanish/French/Italian/Portuguese
  /^El .{1,120}? escribi[oó]\s*:\s*$/i,              // Spanish (redundant but explicit anchor)
  /^Le .{1,120}? a écrit\s*:\s*$/i,                  // French (explicit anchor)
  /^Am .{1,120}? schrieb\s*:?\s*$/i,                 // German (explicit anchor)
  /^Il .{1,120}? ha scritto\s*:\s*$/i,              // Italian (anchored with "Il ")
  /^Em .{1,120}? escreveu\s*:\s*$/i,                // Portuguese (anchored with "Em ")
  /^-{3,}\s*Original Message\s*-{3,}\s*$/i,          // Outlook EN
  /^-{3,}\s*Mensaje original\s*-{3,}\s*$/i,          // Outlook ES
];

function isQuoteSeparatorLine(line) {
  return QUOTE_SEPARATOR_PATTERNS.some(pat => pat.test(String(line || '').trim()));
}

/**
 * Strip quoted blocks from HTML body using DOM-aware parsing.
 *
 * Handles:
 *   - <blockquote class="gmail_quote">
 *   - <div class="gmail_quote">
 *   - <blockquote type="cite">
 *   - Generic <blockquote> starting with quote separators
 *   - Outlook/Apple Mail pattern: <div>On ... wrote:</div> followed by siblings
 *   - "-----Original Message-----" separators
 *   - "De:" / "From:" separators in block elements
 */
export function stripQuotesHtml(html) {
  if (!html) return html;

  // Phase 1: Remove known quote containers.
  let result = html;

  // Remove known quote containers with an HTML parser instead of greedy regex.
  // Regex can over-strip content between two independent gmail_quote blocks;
  // sanitize-html's exclusiveFilter removes the matched element and its
  // descendants while preserving legitimate siblings between quote blocks.
  result = sanitizeHtml(result, {
    allowedTags: EMAIL_ALLOWED_TAGS,
    allowedAttributes: { '*': EMAIL_ALLOWED_ATTRS },
    allowVulnerableTags: true,
    exclusiveFilter(frame) {
      const tag = String(frame.tag || '').toLowerCase();
      const cls = String(frame.attribs?.class || '');
      const type = String(frame.attribs?.type || '');
      return (
        ((tag === 'blockquote' || tag === 'div') && /\bgmail_quote\b/i.test(cls)) ||
        (tag === 'blockquote' && type.toLowerCase() === 'cite')
      );
    },
  });

  // Phase 2: Outlook/Apple Mail pattern stripping.
  // These clients don't wrap quotes in blockquotes — they use plain <div>/<p>:
  //   <p>my reply</p><div>On Mon, Bob wrote:</div><div>previous content</div>
  // We find the first quote-separator text in the HTML and cut everything from
  // the start of its enclosing block tag onwards.
  //
  // Strategy: convert HTML to lines (block-element boundaries → newlines),
  // match separator patterns anchored to start-of-line with `^`, then map
  // the matched line's position back into the original HTML.
  //
  // The `^` anchor + multiline flag ensures we only match separator text that
  // occupies its own block element, not embedded in running paragraph text.
  const plainText = result
    .replace(/<\/(?:div|p|blockquote|section|article|aside|header|footer|main)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  for (const pat of QUOTE_SEPARATOR_PATTERNS.map(p => new RegExp(p.source, 'im'))) {
    const m = plainText.match(pat);
    if (!m) continue;

    // Guard: separator must be at start of a line (position 0 or after \n).
    if (m.index > 0 && plainText[m.index - 1] !== '\n') continue;

    // Map the match position from plainText (with newlines) to the HTML.
    // We walk the HTML, counting only text characters (skipping tags).
    // Newlines inserted by block-element boundaries count as 1 char each.
    // When our text counter reaches m.index, we've found the HTML position
    // of the separator text.
    //
    // We also track lastBlockOpen: the HTML position of the last opening
    // block tag before the separator — this is where we cut.
    const targetTextPos = m.index;
    let htmlIdx = 0, textIdx = 0, lastBlockOpen = -1;

    while (htmlIdx < result.length) {
      if (result[htmlIdx] === '<') {
        // Closing block tag → emit newline in text coordinate space
        const closeMatch = result.slice(htmlIdx).match(
          /^<\/(div|p|blockquote|section|article|aside|header|footer|main)>/i
        );
        if (closeMatch) {
          textIdx++; // count the newline
          htmlIdx += closeMatch[0].length;
          continue;
        }
        // Opening block tag → record position
        const rest = result.slice(htmlIdx);
        if (/^<(div|p|blockquote|section|article|aside|header|footer|main)\b[^>]*>/i.test(rest)) {
          lastBlockOpen = htmlIdx;
        }
        const closeBracket = result.indexOf('>', htmlIdx);
        if (closeBracket === -1) break;
        htmlIdx = closeBracket + 1;
      } else {
        if (textIdx >= targetTextPos) break;
        textIdx++;
        htmlIdx++;
      }
    }

    if (lastBlockOpen >= 0 && lastBlockOpen > result.length * 0.1) {
      result = result.slice(0, lastBlockOpen);
    }
    break;
  }

  return result;
}

/**
 * Strip quoted lines from plain text body.
 */
export function stripQuotesText(text) {
  if (!text) return text;
  const lines = text.split('\n');
  const result = [];
  let inQuoteBlock = false;

  for (const line of lines) {
    if (isQuoteSeparatorLine(line)) {
      inQuoteBlock = true;
      continue;
    }
    if (inQuoteBlock) continue;
    if (/^>\s?.*$/.test(line)) continue;
    result.push(line);
  }

  return result.join('\n').trim();
}

// ─── Attachment deduplication ─────────────────────────────────────────

/**
 * Deduplicate attachments by content hash first, then version by filename.
 *
 * Exact duplicate content (same sha256, common in forwards/replies) is emitted
 * once and every message points at the canonical filename. Different content
 * with the same filename is treated as revisions: newest keeps the original
 * name, older revisions get date-stamped suffixes.
 */
function dedupAttachments(allAttachments) {
  const byHash = new Map();
  for (let i = 0; i < allAttachments.length; i++) {
    const att = allAttachments[i];
    const key = att.sha256 || `${att.filename}:${att.size}:${i}`;
    if (!byHash.has(key)) byHash.set(key, []);
    byHash.get(key).push({ att, index: i });
  }

  const representatives = [];
  for (const [, entries] of byHash) {
    entries.sort((a, b) => (a.att._msgDate || 0) - (b.att._msgDate || 0));
    const canonical = entries[entries.length - 1].att;
    representatives.push({ att: canonical, entries });
  }

  // Group unique-content representatives by original filename.
  const groups = new Map(); // filename → [{ rep, index }]
  for (let i = 0; i < representatives.length; i++) {
    const rep = representatives[i];
    const filename = rep.att.filename;
    if (!groups.has(filename)) groups.set(filename, []);
    groups.get(filename).push({ rep, index: i });
  }

  // Build name mapping: original filename → final filename for each attachment
  const nameMap = new Map(); // att reference → final filename
  const emitted = new Set();

  function uniqueName(candidate) {
    if (!emitted.has(candidate)) {
      emitted.add(candidate);
      return candidate;
    }
    const dot = candidate.lastIndexOf('.');
    const ext = dot > 0 ? candidate.slice(dot) : '';
    const base = dot > 0 ? candidate.slice(0, dot) : candidate;
    let n = 1;
    let name;
    do { name = `${base}_${n}${ext}`; n++; } while (emitted.has(name));
    emitted.add(name);
    return name;
  }

  for (const [, entries] of groups) {
    if (entries.length === 1) {
      const att = entries[0].rep.att;
      const finalName = uniqueName(att.filename);
      nameMap.set(att, finalName);
      for (const { att: linked } of entries[0].rep.entries) {
        if (linked !== att) nameMap.set(linked, finalName);
      }
      continue;
    }

    entries.sort((a, b) => (a.rep.att._msgDate || 0) - (b.rep.att._msgDate || 0));

    for (let j = 0; j < entries.length; j++) {
      const att = entries[j].rep.att;
      let finalName;
      if (j < entries.length - 1) {
        const dot = att.filename.lastIndexOf('.');
        const ext = dot > 0 ? att.filename.slice(dot) : '';
        const base = dot > 0 ? att.filename.slice(0, dot) : att.filename;
        const dateSuffix = att._msgDateStr || String(j + 1);
        finalName = uniqueName(`${base}_${dateSuffix}${ext}`);
      } else {
        finalName = uniqueName(att.filename);
      }
      nameMap.set(att, finalName);
      for (const { att: linked } of entries[j].rep.entries) {
        if (linked !== att) nameMap.set(linked, finalName);
      }
    }
  }

  // Build final attachments from representatives only (no mutation of originals).
  // Clone content buffers to avoid sharing references with parsedMessages.
  const result = new Array(representatives.length).fill(null);
  for (let i = 0; i < representatives.length; i++) {
    const att = representatives[i].att;
    const finalName = nameMap.get(att) || att.filename;
    result[i] = {
      filename: finalName,
      contentType: att.contentType || 'application/octet-stream',
      content: Buffer.from(att.content), // clone to avoid shared reference
      size: att.size || att.content?.length || 0,
      sha256: att.sha256,
    };
  }

  // Build a WeakSet of representative attachments for O(1) lookup
  const repSet = new WeakSet(representatives.map(r => r.att));

  // Apply filename mapping to per-message attachment metadata (the light
  // objects used in threadMeta and buildThreadHtml) without mutating the
  // original attachment objects from parsedMessages.
  // Non-representative attachment .content is nulled to release memory early.
  // This is intentional: finalAttachments owns cloned buffers, and
  // parsedMessages[i].attachments is only used for metadata (filename,
  // contentType, size) in threadMeta and HTML rendering.
  for (const att of allAttachments) {
    const mapped = nameMap.get(att);
    if (mapped) att._finalFilename = mapped;
    if (!repSet.has(att)) {
      att.content = null;
    }
  }

  return result.filter(Boolean);
}

// ─── Thread HTML builder (for PDF) ────────────────────────────────────

function buildThreadHtml(messages, timezone) {
  const parts = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const borderStyle = i > 0
      ? 'border-top: 3px solid #ccc; margin-top: 20px; padding-top: 20px;'
      : '';

    parts.push(`
<div style="${borderStyle}">
  <div style="background: #f5f5f5; padding: 10px 15px; border-radius: 5px; margin-bottom: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px; color: #555;">
    <table style="width: 100%; border-collapse: collapse;">
      <tr><td style="font-weight: bold; width: 60px;">From:</td><td>${escapeHtml(msg.from)}</td></tr>
      <tr><td style="font-weight: bold;">To:</td><td>${escapeHtml(msg.to.join(', '))}</td></tr>
      ${msg.cc.length ? `<tr><td style="font-weight: bold;">Cc:</td><td>${escapeHtml(msg.cc.join(', '))}</td></tr>` : ''}
      <tr><td style="font-weight: bold;">Date:</td><td>${escapeHtml(formatDisplayDate(msg.date, timezone))}</td></tr>
      <tr><td style="font-weight: bold;">Subject:</td><td>${escapeHtml(msg.subject)}</td></tr>
    </table>
  </div>
  <div class="eml2pdf-message-body" style="padding: 0 10px;">
    ${msg.html}
    ${attachmentListHtml(msg.attachments, true)}
  </div>
</div>`);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${EMAIL_RENDER_CSP}">
<style>
  @page { size: auto; margin: 0 }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  td, th { padding: 4px 8px; }
${EMAIL_RENDER_DEFENSIVE_CSS}
</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>`;
}

// ─── Thread Markdown builder ──────────────────────────────────────────

function buildThreadMarkdown(messages, threadMeta, timezone) {
  const td = getTurndownService();
  const lines = [];

  // YAML frontmatter
  const frontmatter = {
    thread_id: threadMeta.threadId || null,
    subject: threadMeta.subject || '',
    participants: threadMeta.participants || [],
    date_range: threadMeta.dateRange || null,
    message_count: messages.length,
    timezone,
    quote_mode: threadMeta.quoteMode,
  };

  lines.push('---');
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== null && v !== undefined) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---');
  lines.push('');

  const subject = mdEscapeInline(threadMeta.subject || 'Email Thread');
  lines.push(`# ${subject}`);
  const escapedParticipants = (threadMeta.participants || []).map(p => mdEscapeInline(p));
  lines.push(`> ${messages.length} message${messages.length !== 1 ? 's' : ''} · ${escapedParticipants.join(', ')}`);
  lines.push('');

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const dateStr = formatDisplayDate(msg.date, timezone);

    lines.push('---');
    lines.push('');
    lines.push(`## Message ${i + 1}`);
    lines.push('');
    lines.push(`**From:** ${mdEscapeInline(msg.from)} · **Date:** ${dateStr}`);
    if (msg.to.length) lines.push(`**To:** ${msg.to.map(mdEscapeInline).join(', ')}`);
    if (msg.cc.length) lines.push(`**Cc:** ${msg.cc.map(mdEscapeInline).join(', ')}`);
    lines.push('');

    // Use HTML if available, fall back to escaped text
    const bodyMd = normalizeResidualHtml(td.turndown(msg.html || `<p>${escapeHtml(msg.text || '')}</p>`).trim());
    lines.push(bodyMd);

    if (msg.attachments.length) {
      lines.push('');
      lines.push(`**Attachments:** ${msg.attachments.map(a => `\`${(a._finalFilename || a.filename).replace(/`/g, "'")}\``).join(', ')}`);
    }
    lines.push('');
  }

  // Thread-level attachments summary
  if (threadMeta.attachments?.length) {
    lines.push('---');
    lines.push('');
    lines.push('## All Attachments');
    lines.push('');
    for (const att of threadMeta.attachments) {
      const size = typeof att.size === 'number' ? ` (${formatBytes(att.size)})` : '';
      lines.push(`- \`${att.filename.replace(/`/g, "'")}\` — ${att.contentType}${size}`);
    }
  }

  if (threadMeta.warnings?.length) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Conversion warnings');
    lines.push('');
    for (const w of threadMeta.warnings) lines.push(`- ${mdEscapeInline(w)}`);
  }

  return lines.join('\n') + '\n';
}

// ─── Main thread conversion ──────────────────────────────────────────

/**
 * Convert a thread of email messages into a unified ZIP.
 *
 * @param {object[]} rawMessages - Array of { rawBase64Url|emlBase64, messageId, internalDate }
 * @param {object} opts - { threadId, timezone, outputs, quoteMode, widthPx, maxHeightPx, loadRemoteImages, ... }
 * @returns {Promise<{ zipBuffer: Buffer, metadata: object }>}
 */
export async function convertThread(rawMessages, opts = {}) {
  const {
    threadId = null,
    timezone = 'UTC',
    outputs = ['pdf', 'markdown'],
    quoteMode = 'preserve',
    widthPx = 900,
    maxHeightPx = 60000,
    loadRemoteImages = false,
    remoteDisabledReason = null,
    timeout = 120_000,
  } = opts;

  const wantPdf = outputs.includes('pdf');
  const wantMd = outputs.includes('markdown');
  const doStrip = quoteMode === 'strip';

  if (!rawMessages || !Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw Object.assign(new Error('messages array must not be empty'), { status: 400 });
  }

  // Parse and process all messages
  const parsedMessages = [];
  const allAttachments = [];
  const warnings = [];

  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    let emlBuf;

    if (raw.emlBase64) {
      // P2 fix: strict base64 validation
      const trimmed = String(raw.emlBase64).replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*=*$/.test(trimmed)) {
        throw Object.assign(new Error(`messages[${i}] has invalid emlBase64`), { status: 400 });
      }
      emlBuf = Buffer.from(trimmed, 'base64');
      if (emlBuf.length === 0) {
        throw Object.assign(new Error(`messages[${i}] has empty emlBase64`), { status: 400 });
      }
    } else if (raw.rawBase64Url) {
      const normalized = String(raw.rawBase64Url).replace(/-/g, '+').replace(/_/g, '/');
      if (!/^[A-Za-z0-9+/]*=*$/.test(normalized)) {
        throw Object.assign(new Error(`messages[${i}] has invalid rawBase64Url`), { status: 400 });
      }
      emlBuf = Buffer.from(normalized, 'base64');
      if (emlBuf.length === 0) {
        throw Object.assign(new Error(`messages[${i}] has empty rawBase64Url`), { status: 400 });
      }
    } else {
      throw Object.assign(
        new Error(`messages[${i}] must have rawBase64Url or emlBase64`),
        { status: 400 }
      );
    }


    const mail = await simpleParser(emlBuf, { skipImageLinks: true });

    // Build sanitized HTML first. CID resolution must happen after quote
    // stripping so inline/attachment decisions reflect the final rendered body.
    const { body: bodyRaw } = buildSingleHtml(mail, timezone, warnings, { resolveCids: false });

    // Strip quotes BEFORE filtering remote URLs. For text/plain-only mail,
    // rebuild the HTML from stripped text so `>` quote lines do not survive
    // through mailparser's generated textAsHtml.
    const strippedText = doStrip ? stripQuotesText(mail.text) : (mail.text || '');
    let processedBody;
    const cidRefsBeforeStrip = doStrip ? extractCidRefs(bodyRaw) : new Set();
    if (doStrip && !mail.html && mail.text) {
      processedBody = `<p>${escapeHtml(strippedText).replace(/\n/g, '<br>')}</p>`;
    } else {
      processedBody = doStrip ? stripQuotesHtml(bodyRaw) : bodyRaw;
    }
    const cidRefsAfterStrip = doStrip ? extractCidRefs(processedBody) : new Set();
    const removedCids = new Set();
    if (doStrip) {
      for (const cid of cidRefsBeforeStrip) {
        if (!cidRefsAfterStrip.has(cid)) removedCids.add(cid);
      }
    }

    const { body: bodyWithImages, usedCids, usedAttachmentIndexes } = resolveCidImages(processedBody, mail, warnings);
    processedBody = bodyWithImages;

    // Apply remote URL policy
    processedBody = await filterRemoteUrls(processedBody, { loadRemoteImages, warnings });

    // P1 fix: Gmail returns internalDate as epoch-ms string (e.g. "1745856000000").
    // Must parse as Number; new Date(string) only handles ISO date strings.
    let date;
    if (raw.internalDate != null && String(raw.internalDate).trim() !== '') {
      const ms = Number(raw.internalDate);
      date = Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
    }
    if (!date || !Number.isFinite(date.getTime())) {
      if (mail.date && Number.isFinite(mail.date.getTime())) {
        date = mail.date;
      } else {
        warnings.push(`messages[${i}] has no parseable date; sorting first`);
        date = new Date(0);
      }
    }
    const subject = mail.subject || '';
    const from = mail.from?.text || '';
    const to = (mail.to?.value || []).map(a => a.text || a.address);
    const cc = (mail.cc?.value || []).map(a => a.text || a.address);

    const msgAttachments = extractAttachments(mail, usedCids, { removedCids, usedAttachmentIndexes });
    // Tag each attachment with the message date for dedup renaming
    for (const att of msgAttachments) {
      att._msgDate = date.getTime();
      att._msgDateStr = formatDateSuffix(date, timezone);
    }
    allAttachments.push(...msgAttachments);

    parsedMessages.push({
      messageId: raw.messageId || mail.messageId || undefined,
      subject,
      from,
      to,
      cc,
      date,
      html: processedBody,
      text: strippedText,
      attachments: msgAttachments,
    });
  }

  // Sort chronologically
  parsedMessages.sort((a, b) => a.date - b.date);

  // Deduplicate attachments
  const finalAttachments = dedupAttachments([...allAttachments]);

  // Thread metadata
  const firstDate = parsedMessages[0].date;
  const lastDate = parsedMessages[parsedMessages.length - 1].date;
  const baseName = formatTimestampStem(lastDate, timezone, 'thread');

  const participants = [...new Set(
    parsedMessages.flatMap(m => [m.from, ...m.to, ...m.cc]).filter(Boolean)
  )];

  const threadMeta = {
    threadId,
    subject: parsedMessages[parsedMessages.length - 1].subject || parsedMessages[0].subject,
    participants,
    dateRange: `${firstDate.toISOString()} — ${lastDate.toISOString()}`,
    messageCount: parsedMessages.length,
    quoteMode,
    timezone,
    messages: parsedMessages.map(m => ({
      messageId: m.messageId,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
      date: m.date.toISOString(),
      attachments: m.attachments.map(a => ({
        filename: a._finalFilename || a.filename,
        contentType: a.contentType,
        size: a.size,
        sha256: a.sha256,
      })),
    })),
    attachments: finalAttachments.map(a => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      sha256: a.sha256,
    })),
    outputs,
    warnings,
  };

  // Render PDF
  let pdfBuffer = null;
  if (wantPdf) {
    const threadHtml = buildThreadHtml(parsedMessages, timezone);
    pdfBuffer = await renderPdf(threadHtml, {
      widthPx,
      maxHeightPx,
      loadRemoteImages,
      remoteDisabledReason,
      timeout,
      warnings,
    });
  }

  // Build Markdown
  const markdownText = wantMd
    ? buildThreadMarkdown(parsedMessages, threadMeta, timezone)
    : null;

  // Build ZIP
  const zipBuffer = await createThreadZip({
    baseName,
    pdfBuffer,
    markdownText,
    metadata: threadMeta,
    attachments: finalAttachments,
  });

  return { zipBuffer, metadata: threadMeta };
}

// ─── ZIP creation ─────────────────────────────────────────────────────

function createThreadZip({ baseName, pdfBuffer, markdownText, metadata, attachments }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('data', c => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    if (pdfBuffer) {
      archive.append(pdfBuffer, { name: `${baseName}.pdf` });
    }
    if (markdownText != null) {
      archive.append(Buffer.from(markdownText, 'utf8'), { name: `${baseName}.md` });
    }

    archive.append(Buffer.from(JSON.stringify(metadata, null, 2)), {
      name: `${baseName}.json`,
    });

    for (const att of attachments) {
      archive.append(att.content, { name: `attachments/${att.filename}` });
    }

    archive.finalize();
  });
}
