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
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

import {
  buildHtmlForTest as buildSingleHtml,
  filterRemoteUrlsForTest as filterRemoteUrls,
  EMAIL_ALLOWED_TAGS,
  EMAIL_ALLOWED_ATTRS,
  stripPaginationCss,
  normalizeCid,
  bufferToDataUrl,
  formatDisplayDate,
  extractAttachments,
  escapeHtml,
  sanitizeFilename,
  renderPdf,
} from './convert.js';

// ─── Quote stripping ─────────────────────────────────────────────────

// Separators Gmail/Outlook/etc. insert before quoted text
const QUOTE_SEPARATOR_RE =
  /^\s*(?:On .+ wrote:|El .+ escribió?:|De:|From:|-----Original Message-----)/i;

/**
 * Strip quoted blocks from HTML body.
 * Removes elements matching known quote patterns.
 */
export function stripQuotesHtml(html) {
  if (!html) return html;
  let result = html;

  // Remove blockquote.gmail_quote and its contents
  result = result.replace(
    /<blockquote[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*?<\/blockquote>/gi,
    ''
  );

  // Remove div.gmail_quote and contents
  result = result.replace(
    /<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    ''
  );

  // Remove blockquote[type="cite"] and contents
  result = result.replace(
    /<blockquote[^>]*type=["']cite["'][^>]*>[\s\S]*?<\/blockquote>/gi,
    ''
  );

  // Remove generic <blockquote> blocks that start with a quote separator
  result = result.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (match, inner) => {
      const textContent = inner.replace(/<[^>]+>/g, '').trim();
      if (QUOTE_SEPARATOR_RE.test(textContent)) {
        return '';
      }
      // Check if content starts with quoted lines
      const firstLine = textContent.split('\n')[0];
      if (/^>\s?/.test(firstLine.trim())) {
        return '';
      }
      return match;
    }
  );

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
    if (QUOTE_SEPARATOR_RE.test(line)) {
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

function formatDateSuffix(date, timezone) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}-${get('minute')}`;
  } catch {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
  }
}

/**
 * Deduplicate attachments by filename across all messages.
 *
 * When the same filename appears multiple times (e.g. revised versions of
 * a document), the OLDEST occurrence gets a date-stamped suffix and the
 * NEWEST (last) keeps the original name. This matches the expectation that
 * the latest revision is the canonical one.
 *
 * Example with 3 messages carrying "presentation.pdf":
 *   presentation.pdf                       (newest, keeps original name)
 *   presentation_2025-11-22_15-20.pdf      (older, date-stamped)
 *   presentation_2025-11-21_18-01.pdf      (oldest, date-stamped)
 */
function dedupAttachments(allAttachments) {
  // Group attachments by original filename, preserving order
  const groups = new Map(); // filename → [{ att, msgDate, index }]

  for (let i = 0; i < allAttachments.length; i++) {
    const att = allAttachments[i];
    const name = att.filename;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ att, index: i });
  }

  const result = new Array(allAttachments.length).fill(null);

  for (const [, entries] of groups) {
    if (entries.length === 1) {
      // No conflict — keep as-is
      result[entries[0].index] = entries[0].att;
      continue;
    }

    // Sort by message date ascending (oldest first)
    // The att.msgDate was set in convertThread before calling dedupAttachments
    entries.sort((a, b) => {
      const da = a.att._msgDate || 0;
      const db = b.att._msgDate || 0;
      return da - db;
    });

    // Oldest entries get date-stamped names; the last (newest) keeps the original
    for (let j = 0; j < entries.length; j++) {
      const { att, index } = entries[j];
      if (j < entries.length - 1) {
        // Rename with date suffix
        const dot = att.filename.lastIndexOf('.');
        const ext = dot > 0 ? att.filename.slice(dot) : '';
        const base = dot > 0 ? att.filename.slice(0, dot) : att.filename;
        const dateSuffix = att._msgDateStr || String(j + 1);
        att.filename = `${base}_${dateSuffix}${ext}`;
      }
      // newest entry keeps original filename
      delete att._msgDate;
      delete att._msgDateStr;
      result[index] = att;
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
  <div style="padding: 0 10px;">
    ${msg.html}
  </div>
</div>`);
  }

  // P4 fix: CSP defense-in-depth, same as convert.js wrapForPdf
  const csp = [
    "default-src 'none'",
    "img-src http: https: data: cid:",
    "style-src 'unsafe-inline' http: https:",
    "font-src http: https: data:",
    "media-src http: https: data:",
    "script-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  @page { size: auto; margin: 0 }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  td, th { padding: 4px 8px; }
</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>`;
}

// ─── Thread Markdown builder ──────────────────────────────────────────

function initTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    linkStyle: 'inlined',
  });
  td.use(gfm);
  td.addRule('drop-style', {
    filter: ['style', 'meta', 'title', 'link'],
    replacement: () => '',
  });
  return td;
}

function mdEscapeInline(s) {
  return String(s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}\[\]()#+\-!|>]/g, c => `\\${c}`)
    .trim();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function buildThreadMarkdown(messages, threadMeta, timezone) {
  const td = initTurndown();
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
    const bodyMd = td.turndown(msg.html || `<p>${escapeHtml(msg.text || '')}</p>`).trim();
    lines.push(bodyMd);

    if (msg.attachments.length) {
      lines.push('');
      lines.push(`**Attachments:** ${msg.attachments.map(a => `\`${a.filename.replace(/`/g, "'")}\``).join(', ')}`);
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
    for (const w of threadMeta.warnings) lines.push(`- ${w}`);
  }

  return lines.join('\n') + '\n';
}

// ─── Date formatting for filenames ────────────────────────────────────

function formatThreadBaseName(date, timezone) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}-${get('minute')} thread`;
  } catch {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())} thread`;
  }
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

    if (emlBuf.length === 0) {
      throw Object.assign(
        new Error(`messages[${i}] has empty payload`),
        { status: 400 }
      );
    }

    const mail = await simpleParser(emlBuf);

    // Build HTML using convert.js's proven pipeline (CID resolution, sanitize, etc.)
    const { body: bodyRaw, usedCids } = buildSingleHtml(mail, timezone, warnings);

    // Strip quotes BEFORE filtering remote URLs
    let processedBody = doStrip ? stripQuotesHtml(bodyRaw) : bodyRaw;

    // Apply remote URL policy
    processedBody = await filterRemoteUrls(processedBody, { loadRemoteImages, warnings });

    // P1 fix: Gmail returns internalDate as epoch-ms string (e.g. "1745856000000").
    // Must parse as Number; new Date(string) only handles ISO date strings.
    let date;
    if (raw.internalDate != null) {
      const ms = Number(raw.internalDate);
      date = Number.isFinite(ms) ? new Date(ms) : null;
    }
    if (!date || !Number.isFinite(date.getTime())) {
      date = mail.date || new Date();
    }
    const subject = mail.subject || '';
    const from = mail.from?.text || '';
    const to = (mail.to?.value || []).map(a => a.text || a.address);
    const cc = (mail.cc?.value || []).map(a => a.text || a.address);

    const msgAttachments = extractAttachments(mail, usedCids);
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
      text: doStrip ? stripQuotesText(mail.text) : (mail.text || ''),
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
  const baseName = formatThreadBaseName(lastDate, timezone);

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
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    })),
    attachments: finalAttachments.map(a => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
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
