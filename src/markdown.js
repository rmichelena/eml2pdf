import { getTurndownService, mdEscapeInline, formatBytes, normalizeResidualHtml } from './textutil.js';

export function buildMarkdown(mail, bodyWithImages, metadata) {
  const td = getTurndownService();
  const lines = [];

  const frontmatter = {
    subject: metadata.subject || '',
    from: metadata.from || '',
    to: metadata.to || [],
    cc: metadata.cc || [],
    date: metadata.date,
    timezone: metadata.timezone || null,
    message_id: metadata.messageId || null,
  };
  const fmEntries = Object.entries(frontmatter).filter(([, v]) =>
    v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)
  );
  lines.push('---');
  // Use JSON.stringify for YAML-ish frontmatter values. It safely quotes
  // hostile email metadata containing `:`, newlines, `---`, brackets, etc.;
  // consumers still get valid scalar/array values without Markdown injection.
  for (const [k, v] of fmEntries) lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push('---');
  lines.push('');

  const subject = mdEscapeInline(metadata.subject || '').trim();
  lines.push(`# ${subject || 'Email'}`);
  lines.push('');

  const bodyMd = normalizeResidualHtml(td.turndown(bodyWithImages || '').trim());
  lines.push(bodyMd);

  if (metadata.attachments?.length) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Attachments');
    lines.push('');
    for (const att of metadata.attachments) {
      const size = typeof att.size === 'number' ? ` (${formatBytes(att.size)})` : '';
      const safeName = String(att.filename).replace(/`/g, "'");
      const safeType = String(att.contentType).replace(/`/g, "'");
      lines.push(`- \`${safeName}\` — ${safeType}${size}`);
    }
  }

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
