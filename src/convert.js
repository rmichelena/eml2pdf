import { simpleParser } from 'mailparser';
import { chromium } from 'playwright';
import archiver from 'archiver';

let _browser = null;

async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
      ],
    });
  }
  return _browser;
}

export async function convertEmail(emlBuf, opts = {}) {
  const {
    messageId,
    widthPx = 900,
    maxHeightPx = 30000,
    loadRemoteImages = false,
    timeout = 60000,
    timezone = 'UTC',
  } = opts;

  const warnings = [];

  // Parse MIME
  const mail = await simpleParser(emlBuf);

  // Build HTML with inline images resolved
  const { html, inlineCids, inlineCount } = buildHtml(mail, timezone);

  // Render to PDF
  const pdfBuffer = await renderPdf(html, { widthPx, maxHeightPx, loadRemoteImages, timeout, warnings });

  // Collect non-inline attachments
  const attachments = extractAttachments(mail, inlineCids);

  // Build metadata
  const metadata = {
    messageId: messageId || mail.messageId || undefined,
    subject: mail.subject || '',
    from: mail.from?.text || '',
    to: (mail.to?.value || []).map(a => a.text || a.address),
    cc: (mail.cc?.value || []).map(a => a.text || a.address),
    date: mail.date ? mail.date.toISOString() : null,
    timezone,
    inlineImagesResolved: inlineCount,
    attachments: attachments.map(a => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      inline: false,
    })),
    warnings,
  };

  // ZIP everything — PDF filename uses localized date
  const pdfName = mail.date
    ? formatPdfFilename(mail.date, timezone)
    : 'email.pdf';
  const zipBuffer = await createZip(pdfBuffer, pdfName, metadata, attachments);

  return { zipBuffer, metadata };
}

function buildHtml(mail, timezone = 'UTC') {
  const inlineCids = new Set();
  const attachments = mail.attachments || [];

  // Map cid → data URL for inline images
  const cidMap = new Map();
  for (const att of attachments) {
    if (att.contentId && att.contentType?.startsWith('image/')) {
      const cleanCid = att.contentId.replace(/[<>]/g, '');
      cidMap.set(cleanCid, bufferToDataUrl(att.content, att.contentType));
      inlineCids.add(cleanCid);
    }
  }

  let html = mail.html || mail.textAsHtml || escapeHtml(mail.text || '');

  // Replace cid: references with data URLs
  let inlineCount = 0;
  html = html.replace(/src=["']cid:([^"']+)["']/gi, (m, cid) => {
    const cleanCid = cid.replace(/[<>]/g, '');
    const dataUrl = cidMap.get(cleanCid);
    if (dataUrl) {
      inlineCount++;
      return `src="${dataUrl}"`;
    }
    return m;
  });

  // Strip MS Word page rules
  html = html.replace(/@page\s+\w*\s*\{[^}]*\}/gi, '');

  // Header with localized date
  const ccLine = mail.cc?.text ? `<div><strong>CC:</strong> ${esc(mail.cc.text)}</div>` : '';
  const headerHtml = `
    <div style="margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #ccc;font-family:Arial,sans-serif;font-size:11pt;line-height:1.5">
      <div><strong>From:</strong> ${esc(mail.from?.text || 'Unknown')}</div>
      <div><strong>To:</strong> ${esc(mail.to?.text || 'Unknown')}</div>
      ${ccLine}
      ${mail.subject ? `<div><strong>Subject:</strong> ${esc(mail.subject)}</div>` : ''}
      ${mail.date ? `<div><strong>Date:</strong> ${esc(formatDisplayDate(mail.date, timezone))}</div>` : ''}
    </div>`;

  return {
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:100%}
      body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.4}
      img{max-width:100%;height:auto}
    </style></head><body>${headerHtml}${html}</body></html>`,
    inlineCids,
    inlineCount,
  };
}

async function renderPdf(html, { widthPx, maxHeightPx, loadRemoteImages, timeout, warnings }) {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.setContent(html, { waitUntil: loadRemoteImages ? 'networkidle' : 'commit', timeout });

    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const pdfHeight = Math.min(scrollHeight, maxHeightPx);
    if (scrollHeight > maxHeightPx) {
      warnings.push(`Email body ${scrollHeight}px exceeds maxHeightPx=${maxHeightPx}, truncated`);
    }

    const pdf = await page.pdf({
      printBackground: true,
      width: `${widthPx}px`,
      height: `${pdfHeight}px`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
    await context.close();
  }
}

function extractAttachments(mail, inlineCids) {
  const attachments = [];
  for (const att of mail.attachments || []) {
    if (!att.filename && !att.contentType) continue;

    const cleanCid = att.contentId?.replace(/[<>]/g, '') || null;
    const isInline = cleanCid && inlineCids.has(cleanCid);

    if (!isInline) {
      attachments.push({
        filename: sanitizeFilename(att.filename || `attachment-${attachments.length}`),
        contentType: att.contentType || 'application/octet-stream',
        content: att.content,
        size: att.size || att.content?.length || 0,
      });
    }
  }
  return attachments;
}

async function createZip(pdfBuffer, pdfName, metadata, attachments) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('data', c => chunks.push(c));
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    zip.on('error', reject);

    // Use same date prefix for metadata as PDF (replace .pdf → .json)
    const metaName = pdfName.replace(/\.pdf$/, '.json');
    zip.append(pdfBuffer, { name: pdfName });
    zip.append(Buffer.from(JSON.stringify(metadata, null, 2)), { name: metaName });
    for (const att of attachments) {
      zip.append(att.content, { name: `attachments/${att.filename}` });
    }
    zip.finalize();
  });
}

function formatPdfFilename(date, timezone) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  let yyyy, mm, dd, hh, min;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    yyyy = get('year'); mm = get('month'); dd = get('day');
    hh = get('hour'); min = get('minute');
  } catch {
    // Fallback to UTC
    yyyy = d.getUTCFullYear(); mm = pad(d.getUTCMonth() + 1); dd = pad(d.getUTCDate());
    hh = pad(d.getUTCHours()); min = pad(d.getUTCMinutes());
  }
  // Use dash instead of colon for filename safety
  return `${yyyy}-${mm}-${dd} ${hh}-${min} email.pdf`;
}

function formatDisplayDate(date, timezone) {
  const d = new Date(date);
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return d.toString();
  }
}

function bufferToDataUrl(buf, mime) {
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

function sanitizeFilename(name) {
  return String(name).replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_') || 'unnamed';
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const esc = escapeHtml;
