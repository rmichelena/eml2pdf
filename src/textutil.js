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

  _turndown = td;
  return td;
}

export function mdEscapeInline(s) {
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
