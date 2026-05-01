// HTML-to-Markdown rendering for LLM consumption.
//
// Reuses the same sanitized + cid:-resolved body that goes to the PDF, so
// inline images arrive as `![alt](data:image/...;base64,...)` markdown —
// directly consumable by vision-capable LLMs (Claude, GPT-4o, etc.).
//
// Tables are kept as GFM markdown tables when their structure makes sense;
// the GFM plugin from turndown handles them out of the box.
//
// We do NOT include <style>, <script> (already sanitized), or our outer
// document scaffolding — only the email body content plus a header block
// of the structured metadata.

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

let _service = null;
function service() {
  if (_service) return _service;

  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    linkStyle: 'inlined',
    // Keep image markdown even for huge data URLs — LLMs handle them fine.
    // (turndown by default keeps images, this just makes it explicit.)
  });

  td.use(gfm);

  // Drop our injected outer wrapper — its content is what we want, not the div.
  td.addRule('drop-eml2pdf-wrapper', {
    filter: (node) => node.id === 'eml2pdf-email-body',
    replacement: (content) => content,
  });

  // <style> blocks: not useful for LLMs, drop.
  td.addRule('drop-style', {
    filter: ['style', 'meta', 'title', 'link'],
    replacement: () => '',
  });

  // <hr> — turndown emits `* * *` by default, GFM-friendly is `---`.
  td.addRule('hr', {
    filter: 'hr',
    replacement: () => '\n\n---\n\n',
  });

  // <br> in flow context → newline (turndown default is two spaces + \n
  // which is correct GFM but harder for LLMs to read).
  td.addRule('br', {
    filter: 'br',
    replacement: () => '\n',
  });

  _service = td;
  return _service;
}

/**
 * Build the markdown representation of an email.
 *
 * @param {object} mail               mailparser output
 * @param {string} bodyWithImages     same body string the PDF renders, post-sanitize
 *                                    and post-cid: resolution. Already safe to feed to turndown.
 * @param {object} metadata           same metadata object we put in the JSON sidecar
 * @returns {string}                  markdown text
 */
export function buildMarkdown(mail, bodyWithImages, metadata) {
  const td = service();

  const lines = [];

  // Metadata block as YAML frontmatter. JSON.stringify gives us safe quoting
  // for arbitrary user content (newlines, quotes, control chars) — JSON is
  // a strict subset of YAML so the result parses as both. This is the safest
  // way to expose attacker-controlled fields like Subject / Message-ID
  // without risking Markdown injection (a Subject like "\n# Fake Section"
  // would otherwise add a heading right before the body).
  const frontmatter = {
    subject: metadata.subject || '',
    from: metadata.from || '',
    to: metadata.to || [],
    cc: metadata.cc || [],
    date: metadata.date,
    timezone: metadata.timezone || null,
    message_id: metadata.messageId || null,
  };
  // Drop nullish to keep the block tight.
  const fmEntries = Object.entries(frontmatter).filter(([, v]) =>
    v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)
  );
  lines.push('---');
  for (const [k, v] of fmEntries) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---');
  lines.push('');

  // Subject as H1 too, but escaped. Newlines collapse to space, leading
  // hashes / asterisks / underscores get escaped so they can't form a
  // heading or strong/em accidentally.
  const subject = mdEscapeInline(metadata.subject || '').trim();
  lines.push(`# ${subject || 'Email'}`);
  lines.push('');

  // Body — turndown converts the sanitized HTML.
  const bodyMd = td.turndown(bodyWithImages || '').trim();
  lines.push(bodyMd);

  // Attachments section — list filenames so the LLM knows what came with
  // the email (not their content; that's the PDF's job).
  if (metadata.attachments?.length) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Attachments');
    lines.push('');
    for (const att of metadata.attachments) {
      const size = typeof att.size === 'number' ? ` (${formatBytes(att.size)})` : '';
      // Strip backticks from the filename — they'd break the code span.
      // (Other filename-unsafe chars are already sanitized in convert.js.)
      const safeName = String(att.filename).replace(/`/g, "'");
      const safeType = String(att.contentType).replace(/`/g, "'");
      lines.push(`- \`${safeName}\` — ${safeType}${size}`);
    }
  }

  // Warnings (e.g., unresolved CIDs, blocked remote hosts) so the consumer
  // knows what may be missing from the rendering.
  if (metadata.warnings?.length) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Conversion warnings');
    lines.push('');
    for (const w of metadata.warnings) lines.push(`- ${w}`);
  }

  return lines.join('\n') + '\n';
}

// Escape characters that have meaning inline in Markdown so attacker-controlled
// values (subject, attachment filenames if we ever interpolate them outside
// backticks, etc.) can't inject formatting / structure.
function mdEscapeInline(s) {
  return String(s)
    .replace(/[\r\n]+/g, ' ')         // collapse newlines so a "\n# Heading" can't promote to a section
    .replace(/[\\`*_{}\[\]()#+\-!|>]/g, (c) => `\\${c}`)
    .trim();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
