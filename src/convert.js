import { simpleParser } from 'mailparser';
import { chromium } from 'playwright';
import archiver from 'archiver';
import sanitizeHtml from 'sanitize-html';
import { isPrivateHost } from './netfilter.js';

let _browserPromise = null;

function getBrowser() {
  if (_browserPromise) {
    return _browserPromise.then(async (b) => {
      if (b.isConnected()) return b;
      _browserPromise = null;
      return getBrowser();
    });
  }
  _browserPromise = chromium.launch({
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
  }).then((b) => {
    b.on('disconnected', () => { _browserPromise = null; });
    return b;
  }).catch((err) => {
    _browserPromise = null;
    throw err;
  });
  return _browserPromise;
}

export async function shutdownBrowser() {
  if (!_browserPromise) return;
  try {
    const b = await _browserPromise;
    await b.close();
  } catch { /* ignore */ }
  _browserPromise = null;
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

  const mail = await simpleParser(emlBuf);

  const { html, inlineCount } = buildHtml(mail, timezone);

  const pdfBuffer = await renderPdf(html, { widthPx, maxHeightPx, loadRemoteImages, timeout, warnings });

  const attachments = extractAttachments(mail);

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

  const pdfName = mail.date
    ? formatPdfFilename(mail.date, timezone)
    : 'email.pdf';
  const zipBuffer = await createZip(pdfBuffer, pdfName, metadata, attachments);

  return { zipBuffer, metadata };
}

function buildHtml(mail, timezone = 'UTC') {
  const attachments = mail.attachments || [];

  // Map cid → data URL for inline images
  const cidMap = new Map();
  for (const att of attachments) {
    if (att.contentId && att.contentType?.startsWith('image/')) {
      const cleanCid = att.contentId.replace(/[<>]/g, '');
      cidMap.set(cleanCid, bufferToDataUrl(att.content, att.contentType));
    }
  }

  let rawHtml = mail.html || mail.textAsHtml || escapeHtml(mail.text || '');

  // Replace cid: references with data URLs (and track which were actually used)
  const usedCids = new Set();
  let inlineCount = 0;
  rawHtml = rawHtml.replace(/src=(["'])cid:([^"']+)\1/gi, (m, q, cid) => {
    const cleanCid = cid.replace(/[<>]/g, '');
    const dataUrl = cidMap.get(cleanCid);
    if (dataUrl) {
      usedCids.add(cleanCid);
      inlineCount++;
      return `src=${q}${dataUrl}${q}`;
    }
    return m;
  });

  // Mark used inline cids back on the mail object so extractAttachments can skip them
  mail.__usedInlineCids = usedCids;

  // Strip MS Word page rules (best-effort, single-level brace match)
  rawHtml = rawHtml.replace(/@page\s+\w*\s*\{[^}]*\}/gi, '');

  // Sanitize: keep layout/typography/styling tags & attrs, drop active content.
  // We allow a permissive set so rendering fidelity stays high.
  const cleanBody = sanitizeHtml(rawHtml, {
    allowedTags: false, // allow all tags by default
    allowedAttributes: false, // allow all attributes by default
    disallowedTagsMode: 'discard',
    nonBooleanAttributes: ['*'],
    // Explicit kill list — active content & navigation hijacks
    exclusiveFilter: (frame) => {
      const t = frame.tag?.toLowerCase();
      return t === 'script' || t === 'iframe' || t === 'object' || t === 'embed'
          || t === 'frame' || t === 'frameset' || t === 'applet'
          || t === 'form' || t === 'button' || t === 'input' || t === 'textarea' || t === 'select'
          || t === 'base';
    },
    transformTags: {
      // Strip on* event handlers and javascript: URLs from anywhere
      '*': (tagName, attribs) => {
        const cleaned = {};
        for (const [k, v] of Object.entries(attribs)) {
          if (k.toLowerCase().startsWith('on')) continue;
          if (typeof v === 'string') {
            const trimmed = v.trim().toLowerCase();
            if ((k === 'href' || k === 'src' || k === 'action' || k === 'formaction')
                && (trimmed.startsWith('javascript:') || trimmed.startsWith('vbscript:') || trimmed.startsWith('data:text/html'))) {
              continue;
            }
          }
          cleaned[k] = v;
        }
        return { tagName, attribs: cleaned };
      },
      // Strip http-equiv refresh
      'meta': (tagName, attribs) => {
        if (attribs['http-equiv']?.toLowerCase() === 'refresh') return { tagName: 'span', attribs: {} };
        return { tagName, attribs };
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data', 'cid'],
    },
    allowVulnerableTags: false,
    parseStyleAttributes: false, // keep style attrs as-is for fidelity
  });

  const ccLine = mail.cc?.text ? `<div><strong>CC:</strong> ${esc(mail.cc.text)}</div>` : '';
  const headerHtml = `
    <div style="margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #ccc;font-family:Arial,sans-serif;font-size:11pt;line-height:1.5">
      <div><strong>From:</strong> ${esc(mail.from?.text || 'Unknown')}</div>
      <div><strong>To:</strong> ${esc(mail.to?.text || 'Unknown')}</div>
      ${ccLine}
      ${mail.subject ? `<div><strong>Subject:</strong> ${esc(mail.subject)}</div>` : ''}
      ${mail.date ? `<div><strong>Date:</strong> ${esc(formatDisplayDate(mail.date, timezone))}</div>` : ''}
    </div>`;

  // Permissive CSP: allow images/styles/fonts from network for fidelity,
  // but block scripts, frames, objects, forms.
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

  return {
    html: `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <style>
      html,body{margin:0;padding:0;width:100%}
      body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.4}
      img{max-width:100%;height:auto}
    </style></head><body>${headerHtml}${cleanBody}</body></html>`,
    inlineCount,
  };
}

async function renderPdf(html, { widthPx, maxHeightPx, loadRemoteImages, timeout, warnings }) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    javaScriptEnabled: false, // emails don't need JS — kills a whole class of risk
    viewport: { width: widthPx, height: 1200 },
  });

  // Network filter: always block dangerous schemes & private IPs.
  // When loadRemoteImages=false, additionally block all http(s).
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();

    // Allow data: and inline cid: (cid is rewritten before render, but defensive)
    if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
      return route.continue();
    }

    // The very first navigation to setContent is about:blank, already handled above.
    // Anything else must be http(s).
    if (!/^https?:\/\//i.test(url)) {
      return route.abort('blockedbyclient');
    }

    if (!loadRemoteImages) {
      return route.abort('blockedbyclient');
    }

    let host;
    try { host = new URL(url).hostname; }
    catch { return route.abort('blockedbyclient'); }

    try {
      if (await isPrivateHost(host)) {
        warnings.push(`Blocked private/internal host: ${host}`);
        return route.abort('blockedbyclient');
      }
    } catch {
      return route.abort('blockedbyclient');
    }

    return route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  try {
    // With remote loading, we need networkidle so images/fonts settle before measuring height.
    // Without it, 'load' is enough (no remote requests will fire anyway thanks to the route).
    await page.setContent(html, {
      waitUntil: loadRemoteImages ? 'networkidle' : 'load',
      timeout,
    });

    // Wait for web fonts (matters for fidelity & accurate height measurement)
    await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : null)
      .catch(() => {});
    // Two RAFs for layout flush
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
      .catch(() => {});

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
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function extractAttachments(mail) {
  const usedInlineCids = mail.__usedInlineCids || new Set();
  const attachments = [];
  const seenNames = new Map(); // base name → count

  for (const att of mail.attachments || []) {
    if (!att.filename && !att.contentType) continue;

    const cleanCid = att.contentId?.replace(/[<>]/g, '') || null;
    const isInline = cleanCid && usedInlineCids.has(cleanCid);
    if (isInline) continue;

    let name = sanitizeFilename(att.filename || `attachment-${attachments.length}`);
    // Disambiguate duplicates so ZIP entries don't overwrite
    const count = seenNames.get(name) || 0;
    if (count > 0) {
      const dot = name.lastIndexOf('.');
      name = dot > 0
        ? `${name.slice(0, dot)}_${count}${name.slice(dot)}`
        : `${name}_${count}`;
    }
    seenNames.set(sanitizeFilename(att.filename || `attachment-${attachments.length}`), count + 1);

    attachments.push({
      filename: name,
      contentType: att.contentType || 'application/octet-stream',
      content: att.content,
      size: att.size || att.content?.length || 0,
    });
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
    yyyy = d.getUTCFullYear(); mm = pad(d.getUTCMonth() + 1); dd = pad(d.getUTCDate());
    hh = pad(d.getUTCHours()); min = pad(d.getUTCMinutes());
  }
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
  let s = String(name)
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '_');
  return s || 'unnamed';
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const esc = escapeHtml;
