import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

let _turndown = null;

export function getTurndownService() {
  if (_turndown) return _turndown;

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
  td.addRule('hr', {
    filter: 'hr',
    replacement: () => '\n\n---\n\n',
  });
  td.addRule('br', {
    filter: 'br',
    replacement: () => '\n',
  });
  td.addRule('drop-eml2pdf-wrapper', {
    filter: (node) => node.id === 'eml2pdf-email-body',
    replacement: (content) => content,
  });

  _turndown = td;
  return td;
}

export function mdEscapeInline(s) {
  // Markdown output is consumed by humans and downstream LLM pipelines. Treat
  // email metadata/body text as hostile: escape inline metacharacters so a
  // crafted Subject/From cannot inject headings, links, blockquotes, tables,
  // or emphasis into generated Markdown structure.
  return String(s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}\[\]()#+\-!|>]/g, (c) => `\\${c}`)
    .trim();
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTimestampStem(date, timezone, suffix = 'email', joiner = ' ') {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}${joiner}${get('hour')}-${get('minute')} ${suffix}`;
  } catch {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${joiner}${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())} ${suffix}`;
  }
}

export function formatDateSuffix(date, timezone) {
  const stem = formatTimestampStem(date, timezone, '', '_');
  return stem.trim();
}

/**
 * Turndown intentionally preserves some HTML it cannot safely convert, most
 * notably nested layout tables used by email signatures. For Markdown output
 * we prefer a lossy-but-readable text fallback over raw HTML blobs.
 *
 * This is deliberately post-Turndown and narrow: let Turndown/GFM handle real
 * tables first; only degrade residual HTML blocks that survived into Markdown.
 */
export function normalizeResidualHtml(md) {
  if (!md || !/<[a-z][\s\S]*>/i.test(md)) return md || '';
  return replaceBalancedTableBlocks(String(md))
    .replace(/<div\b[\s\S]*?<\/div>/gi, (html) => {
      // Only touch div blocks that still contain nested HTML tags. Plain text
      // with angle brackets should be left alone.
      return /<\/?(?:table|tbody|tr|td|span|font|img|a|br)\b/i.test(html)
        ? htmlBlockToText(html)
        : html;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function replaceBalancedTableBlocks(input) {
  const tagRe = /<\/?table\b[^>]*>/gi;
  let out = '';
  let cursor = 0;
  let match;

  while ((match = tagRe.exec(input))) {
    if (!/^<table\b/i.test(match[0])) continue;

    const start = match.index;
    let depth = 1;
    let end = -1;
    while ((match = tagRe.exec(input))) {
      if (/^<table\b/i.test(match[0])) depth++;
      else depth--;
      if (depth === 0) {
        end = tagRe.lastIndex;
        break;
      }
    }

    if (end === -1) break; // malformed; leave remainder untouched
    out += input.slice(cursor, start) + htmlBlockToText(input.slice(start, end));
    cursor = end;
  }

  return out + input.slice(cursor);
}

function htmlBlockToText(html) {
  let s = String(html || '');

  // Drop non-content blocks and empty tracking/brand images.
  s = s.replace(/<\/?(?:script|style|meta|link|title)[^>]*>/gi, '');
  s = s.replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, ' $1 ');
  s = s.replace(/<img\b[^>]*>/gi, ' ');

  // Preserve link destinations in a compact Markdown-friendly shape.
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const text = stripTags(label).trim() || href;
    const cleanHref = decodeHtmlEntities(href).trim();
    if (!cleanHref || cleanHref.toLowerCase().startsWith('javascript:')) return text;
    return text === cleanHref ? text : `${text} (${cleanHref})`;
  });

  // Email layout tables: cells are usually visual columns, rows are logical
  // lines. Keep separators but favor readable text over table syntax.
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|h[1-6])>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(?:table|thead|tbody|tfoot)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');

  s = decodeHtmlEntities(s)
    .replace(/[ \t]+\|[ \t]+\|[ \t]+/g, ' | ')
    .replace(/[ \t]*\|[ \t]*(?:\n|$)/g, '\n')
    .replace(/(?:^|\n)[ \t]*\|[ \t]*/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s ? `\n\n${s}\n\n` : '';
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return (Number.isFinite(code) && code >= 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return (Number.isFinite(code) && code >= 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : _;
    });
}
