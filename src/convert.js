import { simpleParser } from 'mailparser';
import { chromium } from 'playwright';
import archiver from 'archiver';
import sanitizeHtml from 'sanitize-html';
import { isPrivateHost } from './netfilter.js';

// Permissive but explicit tag allowlist for email HTML.
// Excludes by omission: script, iframe, object, embed, frame, frameset, applet,
// form/input/button/textarea/select/option/label/fieldset/legend, base, link, noscript.
const EMAIL_ALLOWED_TAGS = [
  // Document / sectioning
  'html', 'head', 'body', 'title', 'style', 'meta',
  'header', 'footer', 'main', 'section', 'article', 'aside', 'nav',
  'div', 'span', 'p', 'br', 'hr', 'wbr',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Inline / typography
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark',
  'small', 'big', 'sub', 'sup', 'font', 'center',
  'abbr', 'acronym', 'cite', 'q', 'kbd', 'samp', 'var', 'code', 'pre',
  'time', 'data', 'bdi', 'bdo', 'ruby', 'rt', 'rp',
  // Lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'menu',
  // Blocks
  'blockquote', 'address', 'figure', 'figcaption', 'details', 'summary',
  // Tables (heavy use in email)
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'colgroup', 'col',
  // Media
  'img', 'picture', 'source', 'map', 'area',
];

const EMAIL_ALLOWED_ATTRS = [
  // Generic
  'id', 'class', 'style', 'title', 'lang', 'dir', 'role', 'tabindex',
  // ARIA — non-executable, ok to keep
  'aria-label', 'aria-hidden', 'aria-describedby', 'aria-labelledby',
  // Anchor / image
  'href', 'target', 'rel', 'name', 'src', 'alt', 'srcset', 'sizes',
  'usemap', 'ismap', 'shape', 'coords',
  'loading', 'decoding', 'referrerpolicy', 'crossorigin',
  // Sizing / legacy presentational (Outlook/Word/marketing emails rely on these)
  'width', 'height', 'align', 'valign', 'border', 'bgcolor', 'color',
  'background',  // <body|table|td background="..."> — used by hero images
  'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'span',
  'face', 'size', 'nowrap', 'hspace', 'vspace',
  // Tables
  'summary', 'scope', 'headers', 'abbr',
  // Meta (limited — meta refresh is rewritten in transformTags)
  'charset', 'http-equiv', 'content',
  // <style> / <link>
  'type', 'media',
  // <time>
  'datetime',
];

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

  const { html, inlineCount, usedCids } = buildHtml(mail, timezone, warnings);

  const pdfBuffer = await renderPdf(html, { widthPx, maxHeightPx, loadRemoteImages, timeout, warnings });

  const attachments = extractAttachments(mail, usedCids);

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

function normalizeCid(value = '') {
  let cid = String(value)
    .trim()
    .replace(/^cid:/i, '')
    .replace(/&lt;|&gt;/gi, '')   // HTML-encoded angle brackets
    .replace(/[<>]/g, '');
  try { cid = decodeURIComponent(cid); } catch { /* keep as-is */ }
  return cid;
}

export { buildHtml as buildHtmlForTest };

function buildHtml(mail, timezone = 'UTC', warnings = []) {
  const attachments = mail.attachments || [];

  // Build a cid → data URL map for all image attachments with a Content-ID,
  // and a parallel cid → dataUrl record we'll use later to detect which
  // images actually ended up inline in the rendered HTML.
  // Casing is inconsistent across clients, so index both canonical and lowercase.
  const cidMap = new Map();
  const dataUrlByCid = new Map();
  for (const att of attachments) {
    if (att.contentId && att.contentType?.startsWith('image/')) {
      const cid = normalizeCid(att.contentId);
      const dataUrl = bufferToDataUrl(att.content, att.contentType);
      cidMap.set(cid, dataUrl);
      cidMap.set(cid.toLowerCase(), dataUrl);
      dataUrlByCid.set(cid, dataUrl);
    }
  }

  let rawHtml = mail.html || mail.textAsHtml || escapeHtml(mail.text || '');

  // Strip MS Word page rules (best-effort, single-level brace match)
  rawHtml = rawHtml.replace(/@page\s+\w*\s*\{[^}]*\}/gi, '');

  // Sanitize FIRST — before we splice giant data: URLs into the markup. This
  // also lets the parser normalize attribute formatting (entity-encoded chars,
  // weird quoting) so the regex below sees uniform `src="cid:..."` strings.
  // Note: 'cid' is in allowedSchemes, so cid: URLs survive sanitization intact.
  const cleanBody = sanitizeHtml(rawHtml, {
    allowedTags: EMAIL_ALLOWED_TAGS,
    allowedAttributes: { '*': EMAIL_ALLOWED_ATTRS },
    disallowedTagsMode: 'discard',
    selfClosing: ['img', 'br', 'hr', 'col', 'wbr', 'source', 'area'],
    transformTags: {
      // Strip on* handlers and dangerous URL schemes from any tag.
      '*': (tagName, attribs) => {
        const cleaned = {};
        for (const [k, v] of Object.entries(attribs)) {
          if (k.toLowerCase().startsWith('on')) continue;
          if (typeof v === 'string'
              && (k === 'href' || k === 'src' || k === 'action' || k === 'formaction' || k === 'background')) {
            const t = v.trim().toLowerCase();
            if (t.startsWith('javascript:') || t.startsWith('vbscript:') || t.startsWith('data:text/html')) {
              continue;
            }
          }
          cleaned[k] = v;
        }
        return { tagName, attribs: cleaned };
      },
      // Drop <meta http-equiv="refresh"> — turn into an inert span.
      meta: (tagName, attribs) => {
        if (attribs['http-equiv']?.toLowerCase() === 'refresh') return { tagName: 'span', attribs: {} };
        return { tagName, attribs };
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data', 'cid'],
    },
    parseStyleAttributes: false, // keep style attrs as-is for fidelity
    // We intentionally keep <style> and <meta> in the allowlist — both are
    // essential for email rendering fidelity (Outlook/marketing emails rely
    // heavily on <style>). Defenses in depth that make this safe here:
    //   - JS is disabled in the rendering BrowserContext (no script execution)
    //   - CSP injected in <head> blocks scripts/frames/objects/forms
    //   - context.route blocks private/internal hosts and dangerous schemes
    //     (so @import / url() can only fetch public resources, same as <img>)
    //   - <meta http-equiv="refresh"> is rewritten to an inert <span> above
    allowVulnerableTags: true,
  });

  // Resolve any cid: → data: that mailparser didn't already inline.
  // mailparser auto-resolves `<img src="cid:...">` for multipart/related
  // emails, but only the canonical quoted form — unquoted attributes,
  // case-mismatched CIDs, `background=cid:...` (legacy Outlook/marketing),
  // and CSS `url(cid:...)` slip through. Chromium can't load cid: itself
  // in setContent and our context.route would block it anyway, so anything
  // not replaced here would fail to render.
  const unresolvedCids = new Set();

  function resolveCid(rawCid) {
    const cid = normalizeCid(rawCid);
    const dataUrl = cidMap.get(cid) || cidMap.get(cid.toLowerCase());
    if (!dataUrl) {
      unresolvedCids.add(cid);
      return null;
    }
    return dataUrl;
  }

  let bodyWithImages = cleanBody;

  // Pass 1: <img src="cid:..."> and <source src="cid:...">
  bodyWithImages = bodyWithImages.replace(
    /\bsrc\s*=\s*(["']?)\s*cid:([^"'\s>]+)\1/gi,
    (m, q, rawCid) => {
      const dataUrl = resolveCid(rawCid);
      if (!dataUrl) return m;
      const quote = q || '"';
      return `src=${quote}${dataUrl}${quote}`;
    }
  );

  // Pass 2: <body background="cid:...">, <table background="cid:...">,
  //         <td background="cid:..."> — legacy Outlook/marketing pattern.
  bodyWithImages = bodyWithImages.replace(
    /\bbackground\s*=\s*(["']?)\s*cid:([^"'\s>]+)\1/gi,
    (m, q, rawCid) => {
      const dataUrl = resolveCid(rawCid);
      if (!dataUrl) return m;
      const quote = q || '"';
      return `background=${quote}${dataUrl}${quote}`;
    }
  );

  // Pass 3: CSS url(cid:...) inside style="..." attributes or <style> blocks.
  bodyWithImages = bodyWithImages.replace(
    /url\s*\(\s*(["']?)\s*cid:([^"'\s)]+)\1\s*\)/gi,
    (m, q, rawCid) => {
      const dataUrl = resolveCid(rawCid);
      if (!dataUrl) return m;
      const quote = q || '"';
      return `url(${quote}${dataUrl}${quote})`;
    }
  );

  // Determine which image attachments actually made it inline by checking the
  // final HTML for their data: URL. This is robust regardless of which path
  // performed the substitution (mailparser pre-render, our regex above, or
  // even an exotic third route). Comparing the full data URL is fine
  // performance-wise: one substring scan per image attachment per request.
  const usedCids = new Set();
  for (const [cid, dataUrl] of dataUrlByCid) {
    if (bodyWithImages.includes(dataUrl)) {
      usedCids.add(cid);
      usedCids.add(cid.toLowerCase());
    }
  }
  const inlineCount = usedCids.size > 0
    ? new Set([...usedCids].map(c => c.toLowerCase())).size
    : 0;

  // Surface unresolved CIDs individually so metadata.json is diagnostic.
  // Cap the listing to keep the array bounded if a malformed email references
  // dozens of broken cids.
  const MAX_UNRESOLVED_LISTED = 10;
  const unresolvedList = [...unresolvedCids];
  for (const cid of unresolvedList.slice(0, MAX_UNRESOLVED_LISTED)) {
    warnings.push(`Unresolved CID image: ${cid}`);
  }
  if (unresolvedList.length > MAX_UNRESOLVED_LISTED) {
    warnings.push(`…and ${unresolvedList.length - MAX_UNRESOLVED_LISTED} more unresolved CID(s)`);
  }

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
    </style></head><body>${headerHtml}${bodyWithImages}</body></html>`,
    inlineCount,
    usedCids,
  };
}

async function renderPdf(html, { widthPx, maxHeightPx, loadRemoteImages, timeout, warnings }) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    javaScriptEnabled: false, // emails don't need JS — kills a whole class of risk
    viewport: { width: widthPx, height: 1200 },
  });

  // Network filter: always block dangerous schemes & private IPs.
  // When loadRemoteImages=false, additionally block all http(s) and emit a
  // single aggregated warning at the end with the unique blocked hosts (so a
  // tracking-pixel-heavy email doesn't flood the warnings array).
  const blockedRemoteHosts = new Set();

  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();

    if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
      return route.continue();
    }

    if (!/^https?:\/\//i.test(url)) {
      return route.abort('blockedbyclient');
    }

    let host;
    try { host = new URL(url).hostname; }
    catch { return route.abort('blockedbyclient'); }

    if (!loadRemoteImages) {
      blockedRemoteHosts.add(host);
      return route.abort('blockedbyclient');
    }

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
    // IMPORTANT: javaScriptEnabled is false on this context (security layer).
    // That means we MUST NOT await any page.evaluate(...) that returns a Promise
    // whose resolution depends on main-world script execution — e.g.
    // requestAnimationFrame callbacks or any setTimeout-based wait IN the page.
    // Those would deadlock: the callback never fires, the promise never resolves,
    // page.evaluate doesn't honor setDefaultTimeout. Use Playwright's CDP-driven
    // lifecycle waits instead (waitForLoadState, waitForTimeout — both run on
    // the Node side, not in the page).
    //
    // Synchronous evaluates (returning a primitive, like scrollHeight) are fine:
    // they execute in an isolated world via CDP Runtime.evaluate, independent
    // of the page's main-world JS being disabled.
    await page.setContent(html, {
      waitUntil: loadRemoteImages ? 'domcontentloaded' : 'commit',
      timeout,
    });

    if (loadRemoteImages) {
      // Wait for subresources (images, web fonts, external CSS) to settle.
      // Capped so a single slow remote font can't stall a render.
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(timeout, 10_000),
      }).catch(() => warnings.push(
        'Timed out waiting for remote resources; rendering with partial resources'
      ));
    }

    // Small breathing room for the layout/paint cycle after resources settled
    // (or after commit, when remote is off). Larger when remote is on to absorb
    // any post-font reflow.
    await page.waitForTimeout(loadRemoteImages ? 150 : 50);

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

    // Aggregated remote-blocked notice (only when LOAD_REMOTE_IMAGES disabled).
    // Per-host, capped to keep metadata small.
    if (!loadRemoteImages && blockedRemoteHosts.size > 0) {
      const hosts = [...blockedRemoteHosts];
      const MAX_LISTED = 10;
      warnings.push(
        `Blocked ${hosts.length} remote resource host(s) (LOAD_REMOTE_IMAGES disabled): ` +
        hosts.slice(0, MAX_LISTED).join(', ') +
        (hosts.length > MAX_LISTED ? `, …+${hosts.length - MAX_LISTED}` : '')
      );
    }

    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function extractAttachments(mail, usedCids = new Set()) {
  const attachments = [];
  const seenNames = new Map(); // base name → count

  for (const att of mail.attachments || []) {
    if (!att.filename && !att.contentType) continue;

    // usedCids is the authoritative signal: it lists the CIDs whose data: URL
    // ended up in the rendered HTML (whether inlined by mailparser or by our
    // own regex). att.related alone is NOT enough — mailparser sets it for
    // every multipart/related part, including ones whose cid: it couldn't
    // actually substitute, and including ones not referenced anywhere.
    const cid = att.contentId ? normalizeCid(att.contentId) : null;
    const isInline = cid && (usedCids.has(cid) || usedCids.has(cid.toLowerCase()));
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
