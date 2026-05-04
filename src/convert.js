import { simpleParser } from 'mailparser';
import { chromium } from 'playwright';
import archiver from 'archiver';
import sanitizeHtml from 'sanitize-html';
import { createHash } from 'crypto';
import { isPrivateHost } from './netfilter.js';
import { buildMarkdown } from './markdown.js';
import { formatTimestampStem } from './textutil.js';

export const EMAIL_RENDER_CSP = [
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

// Outlook Web App sometimes embeds its full loading screen markup/CSS inside
// forwarded/saved messages. If preserved, the fixed white overlay can cover
// the entire Chromium viewport and produce a visually blank PDF. We remove the
// known loader nodes during sanitization and also hide them in the wrapper CSS
// as a second line of defense.
const OWA_LOADER_IDS = new Set(['loadingscreen', 'loadinglogo', 'mslogo']);

export const EMAIL_RENDER_DEFENSIVE_CSS = `
      #eml2pdf-email-body [id="loadingScreen"],
      #eml2pdf-email-body [id="loadingLogo"],
      #eml2pdf-email-body [id="MSLogo"],
      .eml2pdf-message-body [id="loadingScreen"],
      .eml2pdf-message-body [id="loadingLogo"],
      .eml2pdf-message-body [id="MSLogo"]{
        display:none !important;
        visibility:hidden !important;
        opacity:0 !important;
        pointer-events:none !important;
      }`;

// Permissive but explicit tag allowlist for email HTML.
// Excludes by omission: script, iframe, object, embed, frame, frameset, applet,
// form/input/button/textarea/select/option/label/fieldset/legend, base, link, noscript.
// Also excluded: html, head, body, title, meta. These are document-level tags
// that don't belong inside our outer <body>; we transform <html>/<head>/<body>
// to <div> in transformTags so their *children* survive (especially <style>),
// while the duplicate document scaffolding is dropped.
const EMAIL_ALLOWED_TAGS = [
  // Sectioning & flow
  'style',
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

// Browser singleton with generation tagging + circuit breaker.
//
// Generation tagging:
//   We track a monotonic `_generation` so that when an old browser disconnects,
//   its handler can only invalidate the singleton if no fresher launch has
//   already replaced it. Without that, the disconnected handler from a dying
//   browser could null the promise of a brand-new launch, leaking Chromiums.
//
// Circuit breaker:
//   After MAX_LAUNCH_FAILURES consecutive launch errors, the breaker OPENS
//   and getBrowser fails fast for LAUNCH_BREAKER_COOLDOWN_MS. The 503
//   response carries Retry-After matching the remaining cooldown so clients
//   know when to retry. When the cooldown elapses, the breaker closes
//   (counter reset) and the next caller gets a trial launch:
//     - success → fully recovered
//     - failure → counter starts fresh; if it hits MAX again, breaker
//       reopens for another cooldown
//   This means a transient hiccup recovers automatically; a permanent
//   broken state still doesn't burn CPU.
//
//   Every launch failure (including the first) is tagged status=503 +
//   retryAfter so the client gets a sensible response shape, never a 500.
let _browserPromise = null;
let _generation = 0;
let _consecutiveFailures = 0;
let _launchBlockedUntil = 0;
const MAX_LAUNCH_FAILURES = 3;
const LAUNCH_BREAKER_COOLDOWN_MS = 30_000;

const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--no-first-run',
];

const REMOTE_CACHE_MAX_BYTES = Math.max(0, parseInt(process.env.REMOTE_RESOURCE_CACHE_MB || '100', 10)) * 1024 * 1024;
const REMOTE_CACHE_TTL_MS = Math.max(0, parseInt(process.env.REMOTE_RESOURCE_CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10));
const remoteResourceCache = new Map(); // url → { status, headers, body, bytes, expiresAt, lastUsed }
let remoteResourceCacheBytes = 0;

function cacheableResponse(headers = {}) {
  const cc = String(headers['cache-control'] || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return false;
  const ct = String(headers['content-type'] || '').toLowerCase();
  return /^(image|font)\//.test(ct) || ct.includes('text/css');
}

function fulfillHeaders(headers = {}, bodyLength = null) {
  const out = { ...headers };
  // Playwright's APIResponse.body() is the bytes we will fulfill with. Do not
  // replay transport/framing/compression headers from the upstream response:
  // if the body has already been decoded but `content-encoding: gzip/br` is
  // preserved, Chromium can try to decode it again and intermittently fail to
  // render cached signature images.
  for (const k of Object.keys(out)) {
    const lower = k.toLowerCase();
    if (
      lower === 'content-encoding' ||
      lower === 'content-length' ||
      lower === 'transfer-encoding' ||
      lower === 'connection' ||
      lower === 'keep-alive'
    ) {
      delete out[k];
    }
  }
  if (bodyLength != null) out['content-length'] = String(bodyLength);
  return out;
}

function getCachedRemote(url) {
  if (REMOTE_CACHE_MAX_BYTES <= 0) return null;
  const entry = remoteResourceCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    remoteResourceCache.delete(url);
    remoteResourceCacheBytes -= entry.bytes;
    return null;
  }
  entry.lastUsed = Date.now();
  return entry;
}

function putCachedRemote(url, entry) {
  if (REMOTE_CACHE_MAX_BYTES <= 0 || REMOTE_CACHE_TTL_MS <= 0) return;
  if (entry.status !== 200) return;
  if (!cacheableResponse(entry.headers) || entry.body.length > REMOTE_CACHE_MAX_BYTES) return;
  const prev = remoteResourceCache.get(url);
  if (prev) remoteResourceCacheBytes -= prev.bytes;

  const cached = {
    ...entry,
    bytes: entry.body.length,
    expiresAt: Date.now() + REMOTE_CACHE_TTL_MS,
    lastUsed: Date.now(),
  };
  remoteResourceCache.set(url, cached);
  remoteResourceCacheBytes += cached.bytes;

  while (remoteResourceCacheBytes > REMOTE_CACHE_MAX_BYTES && remoteResourceCache.size > 0) {
    let oldestUrl = null;
    let oldestUsed = Infinity;
    for (const [u, e] of remoteResourceCache) {
      if (e.lastUsed < oldestUsed) {
        oldestUsed = e.lastUsed;
        oldestUrl = u;
      }
    }
    const old = remoteResourceCache.get(oldestUrl);
    remoteResourceCache.delete(oldestUrl);
    remoteResourceCacheBytes -= old.bytes;
  }
}

function getBrowser() {
  if (_browserPromise) {
    const myGen = _generation;
    return _browserPromise.then((b) => {
      if (b.isConnected()) return b;
      // Browser is dead. Only invalidate if a newer launch hasn't already
      // taken over (in which case _generation would have advanced).
      if (_generation === myGen) _browserPromise = null;
      return getBrowser();
    });
  }

  // Circuit breaker.
  const now = Date.now();
  if (_launchBlockedUntil > now) {
    const retryAfter = Math.max(1, Math.ceil((_launchBlockedUntil - now) / 1000));
    return Promise.reject(Object.assign(
      new Error('Chromium launch is in cooldown after repeated failures'),
      { status: 503, retryAfter }
    ));
  }
  if (_launchBlockedUntil > 0) {
    // Cooldown elapsed — close the breaker and allow a single trial launch.
    _launchBlockedUntil = 0;
    _consecutiveFailures = 0;
  }

  _generation++;
  const myGen = _generation;

  _browserPromise = chromium.launch({ headless: true, args: LAUNCH_ARGS })
    .then((b) => {
      _consecutiveFailures = 0;
      _launchBlockedUntil = 0;
      b.on('disconnected', () => {
        if (_generation === myGen) _browserPromise = null;
      });
      return b;
    })
    .catch((err) => {
      _consecutiveFailures++;
      if (_generation === myGen) _browserPromise = null;

      // Trip the breaker if we just hit the failure threshold.
      let retryAfter = 5;
      if (_consecutiveFailures >= MAX_LAUNCH_FAILURES) {
        _launchBlockedUntil = Date.now() + LAUNCH_BREAKER_COOLDOWN_MS;
        retryAfter = Math.ceil(LAUNCH_BREAKER_COOLDOWN_MS / 1000);
      }

      throw Object.assign(
        new Error(`Chromium launch failed: ${err.message}`),
        { status: 503, retryAfter }
      );
    });

  return _browserPromise;
}

/** Snapshot of browser-launch state for health checks / observability. */
export function getBrowserState() {
  const now = Date.now();
  return {
    consecutiveFailures: _consecutiveFailures,
    breakerOpen: _launchBlockedUntil > now,
    breakerRetryAfterSec: _launchBlockedUntil > now
      ? Math.ceil((_launchBlockedUntil - now) / 1000)
      : 0,
  };
}

export async function shutdownBrowser() {
  if (!_browserPromise) return;
  try {
    const b = await _browserPromise;
    await b.close();
  } catch { /* ignore */ }
  _browserPromise = null;
}

const VALID_OUTPUTS = new Set(['pdf', 'markdown']);

export async function convertEmail(emlBuf, opts = {}) {
  const {
    messageId,
    widthPx = 900,
    maxHeightPx = 30000,
    loadRemoteImages = false,
    remoteDisabledReason = null,
    timeout = 60000,
    timezone = 'UTC',
    outputs,
  } = opts;

  // Normalize outputs: undefined/null/empty → ['pdf'] (back-compat).
  // Anything passed must be a non-empty subset of {pdf, markdown}.
  const requestedOutputs = Array.isArray(outputs) && outputs.length > 0
    ? [...new Set(outputs.map(s => String(s).toLowerCase()))]
    : ['pdf'];
  for (const o of requestedOutputs) {
    if (!VALID_OUTPUTS.has(o)) {
      throw Object.assign(
        new Error(`Invalid output format: "${o}". Allowed: pdf, markdown`),
        { status: 400 }
      );
    }
  }
  const wantPdf = requestedOutputs.includes('pdf');
  const wantMd = requestedOutputs.includes('markdown');

  const warnings = [];

  const mail = await simpleParser(emlBuf, { skipImageLinks: true });

  const { body: bodyRaw, inlineCount, usedCids, usedAttachmentIndexes } =
    buildHtml(mail, timezone, warnings);

  // Apply the remote-URL policy statically so both PDF and Markdown see the
  // same body, and the .md never carries http(s) URLs that would have been
  // blocked at fetch time. The PDF render still has its own context.route
  // as defense in depth (catches anything our static analysis missed, e.g.
  // URLs inside @font-face rules).
  const filteredBody = await filterRemoteUrls(bodyRaw, { loadRemoteImages, warnings });
  const attachments = extractAttachments(mail, usedCids, { usedAttachmentIndexes });

  // PDF is the only path that touches Chromium — skip entirely when not asked.
  const pdfBuffer = wantPdf
    ? await renderPdf(wrapForPdf(filteredBody, mail, timezone, attachments), {
        widthPx, maxHeightPx, loadRemoteImages, remoteDisabledReason, timeout, warnings,
      })
    : null;

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
      sha256: a.sha256,
      inline: false,
    })),
    outputs: requestedOutputs,
    warnings,
  };

  // Common date-prefixed base name; the PDF and the MD share it so a
  // downstream pipeline can pair them by filename stem.
  const baseName = mail.date
    ? formatBaseName(mail.date, timezone)
    : 'email';

  const markdownText = wantMd
    ? buildMarkdown(mail, filteredBody, metadata)
    : null;

  const zipBuffer = await createZip({
    baseName,
    pdfBuffer,
    markdownText,
    metadata,
    attachments,
  });

  return { zipBuffer, metadata };
}

// Pagination CSS in email content forces unwanted page breaks in our
// "single long-page PDF" rendering model. We can't rely on a CSS override
// (`* { page-break-*: auto !important }`) because email rules with higher
// selector specificity (e.g. `.MsoNormal { page-break-before: always !important }`)
// win the cascade. Strip the rules at source instead — applied to <style>
// blocks and to inline style attributes alike.
function stripPaginationCss(css = '') {
  return String(css)
    // @page rules (any prefix, like `@page WordSection1 { ... }`).
    // NOTE: this only matches blocks whose body has no nested braces. CSS
    // doesn't allow nested braces inside @page (margin boxes use @-rules,
    // but those are themselves at-rules, not nested literal `{}`), so this
    // is correct for valid CSS. Pathological / malformed input could slip
    // some declarations past, but the per-declaration regex below catches
    // the property names regardless of where they sit.
    .replace(/@page\b[^{]*\{[^{}]*\}/gi, '')
    // page-break-* / break-* / page declarations (with or without trailing ;)
    .replace(
      /\b(?:page-break-before|page-break-after|page-break-inside|break-before|break-after|break-inside|page)\s*:\s*[^;{}]+;?/gi,
      ''
    )
    // mso-* prefixed Word/Outlook variants
    .replace(/\bmso-page-break-before\s*:\s*[^;{}]+;?/gi, '')
    .replace(/\bmso-page-break-after\s*:\s*[^;{}]+;?/gi, '');
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

export {
  buildHtml as buildHtmlForTest,
  filterRemoteUrls as filterRemoteUrlsForTest,
  EMAIL_ALLOWED_TAGS,
  EMAIL_ALLOWED_ATTRS,
  stripPaginationCss,
  normalizeCid,
  bufferToDataUrl,
  attachmentChecksum,
  attachmentListHtml,
  formatBaseName,
  formatDisplayDate,
  resolveCidImages,
  extractCidRefs,
  extractAttachments,
  escapeHtml,
  sanitizeFilename,
};

function buildHtml(mail, timezone = 'UTC', warnings = [], options = {}) {
  const attachments = mail.attachments || [];

  let rawHtml = mail.html || mail.textAsHtml || escapeHtml(mail.text || '');

  // Sanitize FIRST — before we splice giant data: URLs into the markup. This
  // also lets the parser normalize attribute formatting (entity-encoded chars,
  // weird quoting) so the regex below sees uniform `src="cid:..."` strings.
  // Note: 'cid' is in allowedSchemes, so cid: URLs survive sanitization intact.
  const cleanBody = sanitizeHtml(rawHtml, {
    allowedTags: EMAIL_ALLOWED_TAGS,
    allowedAttributes: { '*': EMAIL_ALLOWED_ATTRS },
    disallowedTagsMode: 'discard',
    selfClosing: ['img', 'br', 'hr', 'col', 'wbr', 'source', 'area'],
    // Tags whose entire text content is dropped alongside the tag, regardless
    // of allowedTags. We deliberately omit 'style' here: htmlparser2 (the
    // parser sanitize-html uses) treats <style> as a special raw-text element
    // anyway, and listing it here was redundant in current versions and
    // fragile across upgrades. We do add 'title' so the email's
    // `<head><title>SPAM</title></head>` doesn't leak its text into our
    // rendered body when the head is unwrapped to <div>.
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title'],
    transformTags: {
      // Strip on* handlers, dangerous URL schemes, and pagination CSS from
      // inline style="..." attributes on any tag.
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
          if (k.toLowerCase() === 'style' && typeof v === 'string') {
            cleaned[k] = stripPaginationCss(v);
            continue;
          }
          cleaned[k] = v;
        }
        return { tagName, attribs: cleaned };
      },
      // Email's nested document scaffolding: unwrap <html>/<head>/<body>
      // to <div> so their children survive (notably <style> inside <head>),
      // while we keep our own outer document structure.
      html: (tagName, attribs) => ({ tagName: 'div', attribs }),
      head: (tagName, attribs) => ({ tagName: 'div', attribs }),
      body: (tagName, attribs) => ({ tagName: 'div', attribs }),
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data', 'cid'],
    },
    parseStyleAttributes: false, // keep style attrs as-is for fidelity
    exclusiveFilter(frame) {
      const id = String(frame.attribs?.id || '').toLowerCase();
      return OWA_LOADER_IDS.has(id);
    },
    // We intentionally keep <style> in the allowlist — it's essential for
    // email rendering fidelity (Outlook/marketing emails rely heavily on it).
    // Defenses in depth that make this safe here:
    //   - JS is disabled in the rendering BrowserContext (no script execution)
    //   - CSP injected in <head> blocks scripts/frames/objects/forms
    //   - context.route blocks private/internal hosts and dangerous schemes
    //     (so @import / url() can only fetch public resources, same as <img>)
    //   - <meta http-equiv="refresh"> can't slip through: <meta> is no longer
    //     in the allowlist at all, so sanitize-html discards it entirely
    allowVulnerableTags: true,
  });

  // Strip pagination CSS from <style> blocks (the per-attribute strip is
  // already handled in transformTags '*'). Combined with the @page removal
  // inside stripPaginationCss, this neutralizes Outlook/Word section
  // pagination rules that would otherwise force unwanted page breaks.
  const cleanBodyNoPagination = cleanBody.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open, css, close) => `${open}${stripPaginationCss(css)}${close}`
  );

  if (options.resolveCids === false) {
    return {
      body: cleanBodyNoPagination,
      inlineCount: 0,
      usedCids: new Set(),
    };
  }

  return resolveCidImages(cleanBodyNoPagination, mail, warnings);
}

function buildCidIndex(mail, warnings = []) {
  const cidMap = new Map();
  const byCid = new Map();

  for (let index = 0; index < (mail.attachments || []).length; index++) {
    const att = mail.attachments[index];
    if (!att.contentId || !att.contentType?.startsWith('image/')) continue;
    const cid = normalizeCid(att.contentId);
    const key = cid.toLowerCase();
    const sha256 = attachmentChecksum(att.content);
    const dataUrl = bufferToDataUrl(att.content, att.contentType);
    if (!byCid.has(key)) byCid.set(key, []);
    byCid.get(key).push({ cid, sha256, dataUrl, index });
  }

  for (const [key, entries] of byCid) {
    const distinctHashes = new Set(entries.map(e => e.sha256));
    if (distinctHashes.size > 1) {
      warnings.push(
        `Duplicate Content-ID with different image content: ${entries[0].cid} ` +
        `(${entries.length} MIME parts; resolving references in MIME order)`
      );
    }
    // Keep all entries as a FIFO queue. Duplicate CIDs are malformed but common
    // in Outlook/forwarded mail. Resolving references left-to-right against MIME
    // order is not perfect, but it is better than overwriting or always using
    // the first image for every occurrence.
    cidMap.set(key, { entries, cursor: 0 });
  }
  return cidMap;
}

function resolveCidImages(body, mail, warnings = []) {
  const cidMap = buildCidIndex(mail, warnings);
  const unresolvedCids = new Set();
  const usedCids = new Set();
  const usedAttachmentIndexes = new Set();

  function resolveCid(rawCid) {
    const cid = normalizeCid(rawCid);
    const queue = cidMap.get(cid.toLowerCase());
    if (!queue || !queue.entries.length) {
      unresolvedCids.add(cid);
      return null;
    }
    const entry = queue.entries[Math.min(queue.cursor, queue.entries.length - 1)];
    // Advance only when there are duplicate MIME parts. If a single image is
    // referenced several times, every occurrence should reuse that one part.
    if (queue.entries.length > 1) queue.cursor++;
    usedCids.add(cid);
    usedCids.add(cid.toLowerCase());
    usedAttachmentIndexes.add(entry.index);
    return entry.dataUrl;
  }

  let bodyWithImages = String(body || '');

  // src="cid:..." / background="cid:..." — quoted or unquoted.
  bodyWithImages = bodyWithImages.replace(
    /\b(src|background)\s*=\s*(["']?)\s*cid:([^"'\s>]+)\2/gi,
    (m, attr, q, rawCid) => {
      const dataUrl = resolveCid(rawCid);
      if (!dataUrl) return m;
      const quote = q || '"';
      return `${attr}=${quote}${dataUrl}${quote}`;
    }
  );

  // srcset="cid:... 1x, cid:... 2x". We replace CID URLs inside the
  // attribute value and keep descriptors intact.
  bodyWithImages = bodyWithImages.replace(
    /\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi,
    (m, q, value) => {
      const replaced = value.replace(/(^|[,\s])cid:([^,\s]+)/gi, (mm, prefix, rawCid) => {
        const dataUrl = resolveCid(rawCid);
        return dataUrl ? `${prefix}${dataUrl}` : mm;
      });
      return `srcset=${q}${replaced}${q}`;
    }
  );

  // CSS url(cid:...) inside style="..." attributes or <style> blocks.
  bodyWithImages = bodyWithImages.replace(
    /url\s*\(\s*(["']?)\s*cid:([^"'\s)]+)\1\s*\)/gi,
    (m, q, rawCid) => {
      const dataUrl = resolveCid(rawCid);
      if (!dataUrl) return m;
      const quote = q || '"';
      return `url(${quote}${dataUrl}${quote})`;
    }
  );

  const MAX_UNRESOLVED_LISTED = 10;
  const unresolvedList = [...unresolvedCids];
  for (const cid of unresolvedList.slice(0, MAX_UNRESOLVED_LISTED)) {
    warnings.push(`Unresolved CID image: ${cid}`);
  }
  if (unresolvedList.length > MAX_UNRESOLVED_LISTED) {
    warnings.push(`…and ${unresolvedList.length - MAX_UNRESOLVED_LISTED} more unresolved CID(s)`);
  }

  const inlineCount = usedAttachmentIndexes.size || new Set([...usedCids].map(c => c.toLowerCase())).size;
  return { body: bodyWithImages, inlineCount, usedCids, usedAttachmentIndexes };
}

function extractCidRefs(body) {
  const refs = new Set();
  const s = String(body || '');
  const patterns = [
    /\b(?:src|background)\s*=\s*(["']?)\s*cid:([^"'\s>]+)\1/gi,
    /url\s*\(\s*(["']?)\s*cid:([^"'\s)]+)\1\s*\)/gi,
    /\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi,
  ];
  for (const m of s.matchAll(patterns[0])) refs.add(normalizeCid(m[2]).toLowerCase());
  for (const m of s.matchAll(patterns[1])) refs.add(normalizeCid(m[2]).toLowerCase());
  for (const m of s.matchAll(patterns[2])) {
    for (const cm of m[2].matchAll(/(^|[,\s])cid:([^,\s]+)/gi)) {
      refs.add(normalizeCid(cm[2]).toLowerCase());
    }
  }
  return refs;
}

/**
 * Wrap the sanitized body into a full HTML document for Chromium rendering.
 * Pure: no I/O, no async. Separated from buildHtml so we can apply remote-URL
 * filtering to the body in between, and reuse the same filtered body for
 * both PDF and Markdown.
 */
function wrapForPdf(body, mail, timezone, attachments = []) {
  const ccLine = mail.cc?.text ? `<div><strong>CC:</strong> ${esc(mail.cc.text)}</div>` : '';
  const attachmentHtml = attachmentListHtml(attachments);
  const headerHtml = `
    <div style="margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #ccc;font-family:Arial,sans-serif;font-size:11pt;line-height:1.5">
      <div><strong>From:</strong> ${esc(mail.from?.text || 'Unknown')}</div>
      <div><strong>To:</strong> ${esc(mail.to?.text || 'Unknown')}</div>
      ${ccLine}
      ${mail.subject ? `<div><strong>Subject:</strong> ${esc(mail.subject)}</div>` : ''}
      ${mail.date ? `<div><strong>Date:</strong> ${esc(formatDisplayDate(mail.date, timezone))}</div>` : ''}
    </div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="${EMAIL_RENDER_CSP}">
      <style>
      @page { size: auto; margin: 0 }
      html,body{margin:0;padding:0;width:100%}
      body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.4}
      img{max-width:100%;height:auto}
      /* Defensive belt-and-suspenders: even after we strip page-break and
         break declarations from the email's <style> blocks and inline style
         attributes, force the boundary between our header and the email
         content not to break. The real fix is the source-strip in
         stripPaginationCss; this just guards against a missed corner case. */
      #eml2pdf-email-body,
      #eml2pdf-email-body > :first-child{
        page-break-before:auto !important;
        break-before:auto !important;
      }
${EMAIL_RENDER_DEFENSIVE_CSS}
    </style></head><body>${headerHtml}<div id="eml2pdf-email-body">${body}</div>${attachmentHtml}</body></html>`;
}

function attachmentChecksum(content) {
  return createHash('sha256').update(content || Buffer.alloc(0)).digest('hex');
}

function attachmentIcon(contentType = '', filename = '') {
  const ct = String(contentType).toLowerCase();
  const name = String(filename).toLowerCase();
  if (ct.includes('pdf') || name.endsWith('.pdf')) return '📄';
  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(name)) return '🖼️';
  if (ct.includes('spreadsheet') || /\.(xlsx?|csv|ods)$/.test(name)) return '📊';
  if (ct.includes('word') || /\.(docx?|odt|rtf)$/.test(name)) return '📝';
  if (ct.includes('presentation') || /\.(pptx?|odp)$/.test(name)) return '📽️';
  if (ct.includes('zip') || /\.(zip|rar|7z|tar|gz)$/.test(name)) return '🗜️';
  return '📎';
}

function attachmentListHtml(attachments = []) {
  if (!attachments.length) return '';
  const rows = attachments.map(att => `
    <li style="margin:4px 0;">
      <span style="font-size:14px;margin-right:6px;">${attachmentIcon(att.contentType, att.filename)}</span>
      <strong>${esc(att.filename || 'attachment')}</strong>
      <span style="color:#666;"> — ${esc(att.contentType || 'application/octet-stream')}${typeof att.size === 'number' ? ` · ${esc(formatBytesLocal(att.size))}` : ''}</span>
    </li>`).join('');
  return `
    <div style="margin-top:16px;padding-top:10px;border-top:1px solid #ddd;font-family:Arial,sans-serif;font-size:10.5pt;line-height:1.35;break-inside:avoid;page-break-inside:avoid;">
      <div style="font-weight:bold;margin-bottom:6px;">Adjuntos (${attachments.length})</div>
      <ul style="margin:0;padding-left:20px;">${rows}</ul>
    </div>`;
}

function formatBytesLocal(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Apply the remote-URL policy to the sanitized body BEFORE rendering or
 * markdown emission. Equivalent to what context.route does for the PDF
 * fetch path, but applied statically to the HTML so:
 *   (a) markdown output also honors the policy (the .md never includes
 *       URLs that would have been blocked at fetch time), and
 *   (b) the PDF render saves a network round-trip per blocked URL.
 *
 * Two distinct policies, because not all URLs are equal:
 *
 *   FETCHED — src=, background=, srcset, CSS url(...). These trigger an
 *   automatic network request when the page renders. The whole point of
 *   loadRemoteImages=false is to suppress those fetches.
 *     - data:/cid: pass.
 *     - http(s) with loadRemoteImages=false              blocked.
 *     - http(s) to private/loopback/IMDS host            blocked.
 *     - http(s) to public host (loadRemoteImages=true)   pass.
 *
 *   NAVIGATED — href=. Just a clickable URL the consumer may follow; the
 *   renderer doesn't fetch it. Stripping public hyperlinks degrades the
 *   PDF/Markdown without any privacy/security benefit, so we keep them.
 *   We DO still strip private/IMDS hyperlinks because those are SSRF-
 *   adjacent (an LLM tool or recipient agent might pre-fetch them).
 *     - data:/cid:/mailto:/tel: pass.
 *     - http(s) to private/loopback/IMDS host            blocked.
 *     - http(s) to public host                           pass (always).
 *
 * Replacement: blocked src=/background= become empty values; blocked
 * srcset attributes are dropped; blocked CSS url(...) becomes
 * url(about:blank); blocked href= is stripped (link text remains).
 *
 * Two aggregated warnings (one per category) list the blocked hosts.
 */
async function filterRemoteUrls(body, { loadRemoteImages, warnings }) {
  // Scan for all the URL-bearing forms we know to handle.
  // Each entry: { start, end, kind, host, category: 'fetched' | 'navigated' }
  const matches = [];

  const attrRe = /\b(src|href|background)\s*=\s*(["']?)\s*(https?:\/\/[^"'\s>]+)\2/gi;
  for (const m of body.matchAll(attrRe)) {
    let host;
    try { host = new URL(m[3]).hostname; } catch { continue; }
    const kind = m[1].toLowerCase();
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      kind,
      host,
      category: kind === 'href' ? 'navigated' : 'fetched',
    });
  }

  const cssRe = /url\s*\(\s*(["']?)\s*(https?:\/\/[^"'\s)]+)\1\s*\)/gi;
  for (const m of body.matchAll(cssRe)) {
    let host;
    try { host = new URL(m[2]).hostname; } catch { continue; }
    matches.push({ start: m.index, end: m.index + m[0].length, kind: 'css-url', host, category: 'fetched' });
  }

  // srcset is comma-separated and parsing it correctly is fiddly. If any
  // URL inside is http(s), we drop the entire attribute when policy blocks
  // any of them. Conservative but safe.
  const srcsetRe = /\bsrcset\s*=\s*(["'])([^"']*https?:\/\/[^"']*)\1/gi;
  for (const m of body.matchAll(srcsetRe)) {
    const urls = m[2].split(',').map(s => s.trim().split(/\s+/)[0]).filter(u => /^https?:\/\//i.test(u));
    for (const u of urls) {
      let host;
      try { host = new URL(u).hostname; } catch { continue; }
      matches.push({ start: m.index, end: m.index + m[0].length, kind: 'srcset', host, category: 'fetched' });
    }
  }

  if (matches.length === 0) return body;

  // Resolve privacy of every unique host once (parallel DNS lookups when
  // loadRemoteImages=true; we can skip lookups entirely when it's false
  // for the FETCHED set since we'd block everything anyway, but we still
  // need to know privacy for href= even in that case).
  const allHosts = [...new Set(matches.map(m => m.host))];
  const privateOf = new Map();
  await Promise.all(allHosts.map(async (h) => {
    privateOf.set(h, await isPrivateHost(h).catch(() => true));
  }));

  const blockedFetched = new Set();
  const blockedNavigated = new Set();

  for (const m of matches) {
    if (m.category === 'fetched') {
      if (!loadRemoteImages || privateOf.get(m.host)) {
        blockedFetched.add(m.host);
      }
    } else { // navigated
      // Hyperlinks are kept unless the host is private/IMDS.
      if (privateOf.get(m.host)) {
        blockedNavigated.add(m.host);
      }
    }
  }

  if (blockedFetched.size === 0 && blockedNavigated.size === 0) return body;

  // Apply replacements right-to-left so prior indices stay valid. For
  // srcset where multiple match entries share a range, dedup by start.
  matches.sort((a, b) => b.start - a.start);
  const handledRanges = new Set();
  let out = body;
  for (const m of matches) {
    const blocked = m.category === 'fetched' ? blockedFetched : blockedNavigated;
    if (!blocked.has(m.host)) continue;
    const rangeKey = `${m.start}-${m.end}`;
    if (handledRanges.has(rangeKey)) continue;
    handledRanges.add(rangeKey);

    let replacement;
    if (m.kind === 'css-url') {
      replacement = 'url(about:blank)';
    } else if (m.kind === 'href') {
      replacement = '';
    } else if (m.kind === 'srcset') {
      replacement = '';
    } else {
      // src= / background=
      replacement = `${m.kind}=""`;
    }
    out = out.slice(0, m.start) + replacement + out.slice(m.end);
  }

  const fmtList = (set) => {
    const arr = [...set];
    return arr.slice(0, 10).join(', ') + (arr.length > 10 ? `, …+${arr.length - 10}` : '');
  };

  if (blockedFetched.size > 0) {
    const cause = !loadRemoteImages
      ? 'remote loading disabled by server config (env LOAD_REMOTE_IMAGES=false; set it to true to enable)'
      : 'private/internal host blocked';
    warnings.push(
      `Stripped ${blockedFetched.size} remote-fetch URL host(s) — ${cause}: ${fmtList(blockedFetched)}`
    );
  }
  if (blockedNavigated.size > 0) {
    warnings.push(
      `Stripped ${blockedNavigated.size} hyperlink host(s) (private/internal): ${fmtList(blockedNavigated)}`
    );
  }

  return out;
}

export async function renderPdf(html, { widthPx, maxHeightPx, loadRemoteImages, remoteDisabledReason, timeout, warnings }) {
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

    const cached = getCachedRemote(url);
    if (cached) {
      return route.fulfill({
        status: cached.status,
        headers: fulfillHeaders(cached.headers, cached.body.length),
        body: cached.body,
      });
    }

    try {
      const response = await route.fetch();
      const headers = response.headers();
      const body = await response.body();
      putCachedRemote(url, { status: response.status(), headers, body });
      return route.fulfill({ status: response.status(), headers: fulfillHeaders(headers, body.length), body });
    } catch {
      return route.continue();
    }
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

    // Aggregated remote-blocked notice (only when remote loading disabled).
    // Per-host, capped to keep metadata small. Attribution makes the warning
    // actionable: 'env' = operator capped via LOAD_REMOTE_IMAGES, 'client' =
    // request body passed loadRemoteImages:false.
    if (!loadRemoteImages && blockedRemoteHosts.size > 0) {
      const hosts = [...blockedRemoteHosts];
      const MAX_LISTED = 10;
      const cause = remoteDisabledReason === 'env'
        ? 'remote loading disabled by server config (env LOAD_REMOTE_IMAGES=false; set it to true to enable)'
        : remoteDisabledReason === 'client'
        ? 'request opted out via options.loadRemoteImages:false'
        : 'remote loading disabled';
      warnings.push(
        `Blocked ${hosts.length} remote resource host(s) — ${cause}: ` +
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

function extractAttachments(mail, usedCids = new Set(), options = {}) {
  const attachments = [];
  const seenNames = new Map(); // base name → count
  const removedCids = options.removedCids || new Set();
  const usedAttachmentIndexes = options.usedAttachmentIndexes || null;

  for (let index = 0; index < (mail.attachments || []).length; index++) {
    const att = mail.attachments[index];
    if (!att.filename && !att.contentType) continue;

    // usedCids is the authoritative signal: it lists the CIDs whose data: URL
    // ended up in the rendered HTML (whether inlined by mailparser or by our
    // own regex). att.related alone is NOT enough — mailparser sets it for
    // every multipart/related part, including ones whose cid: it couldn't
    // actually substitute, and including ones not referenced anywhere.
    const cid = att.contentId ? normalizeCid(att.contentId) : null;
    const isInline = usedAttachmentIndexes
      ? usedAttachmentIndexes.has(index)
      : cid && (usedCids.has(cid) || usedCids.has(cid.toLowerCase()));
    const wasRemovedWithQuote = cid && removedCids.has(cid.toLowerCase());
    if (isInline || wasRemovedWithQuote) continue;

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
      sha256: attachmentChecksum(att.content),
    });
  }
  return attachments;
}

/**
 * Build the result ZIP. PDF and Markdown are both optional — at least one
 * must be present. JSON metadata sidecar is always included; attachments
 * always go under `attachments/`. PDF and MD share the same date-prefixed
 * base name so a downstream pipeline can pair them by filename stem.
 */
async function createZip({ baseName, pdfBuffer, markdownText, metadata, attachments }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('data', c => chunks.push(c));
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    zip.on('error', reject);

    if (pdfBuffer) zip.append(pdfBuffer, { name: `${baseName}.pdf` });
    if (markdownText != null) zip.append(Buffer.from(markdownText, 'utf8'), { name: `${baseName}.md` });
    zip.append(Buffer.from(JSON.stringify(metadata, null, 2)), { name: `${baseName}.json` });
    for (const att of attachments) {
      zip.append(att.content, { name: `attachments/${att.filename}` });
    }
    zip.finalize();
  });
}

// Date-prefixed filename stem, e.g. "2025-01-15 10-30 email" — extension
// (`.pdf`/`.md`/`.json`) is appended by the ZIP writer.
function formatBaseName(date, timezone) {
  return formatTimestampStem(date, timezone, 'email');
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
  const cleanMime = String(mime || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
  return `data:${cleanMime};base64,${Buffer.from(buf).toString('base64')}`;
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
