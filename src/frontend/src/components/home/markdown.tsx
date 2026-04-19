import React from 'react';

/**
 * Intentionally minimal Markdown renderer for dashboard instructions.
 * Handles: ATX headings (# ## ###), bullet lists (-, *), **bold**, *italic*,
 * `inline code`, [link](url), blank-line paragraph separation.
 *
 * No nested lists, no code blocks, no tables. If instructions outgrow this,
 * swap for `marked` or `markdown-it`.
 */

type Inline = React.ReactNode;

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const CODE_RE = /`([^`]+)`/g;
const ITALIC_RE = /(^|[^*])\*([^*\n]+)\*/g;

function renderInline(text: string, keyPrefix: string): Inline {
  // Placeholder-based rewrite: replace each markup match with a sentinel, then
  // split on sentinels and stitch React nodes back in. Avoids overlap issues
  // between the four regex passes.
  const tokens: React.ReactNode[] = [];
  let t = text;

  const slots: { marker: string; node: React.ReactNode }[] = [];
  const push = (node: React.ReactNode): string => {
    const marker = `\u0000${slots.length}\u0000`;
    slots.push({ marker, node });
    return marker;
  };

  t = t.replace(LINK_RE, (_m, label: string, url: string) =>
    push(
      <a key={`${keyPrefix}-lnk-${slots.length}`} href={url} target="_blank" rel="noreferrer">
        {label}
      </a>,
    ),
  );
  t = t.replace(CODE_RE, (_m, code: string) =>
    push(<code key={`${keyPrefix}-cd-${slots.length}`}>{code}</code>),
  );
  t = t.replace(BOLD_RE, (_m, inner: string) =>
    push(<strong key={`${keyPrefix}-b-${slots.length}`}>{inner}</strong>),
  );
  t = t.replace(ITALIC_RE, (_m, lead: string, inner: string) =>
    lead + push(<em key={`${keyPrefix}-i-${slots.length}`}>{inner}</em>),
  );

  const parts = t.split(/(\u0000\d+\u0000)/);
  for (const part of parts) {
    if (!part) continue;
    const slot = slots.find((s) => s.marker === part);
    tokens.push(slot ? slot.node : part);
  }
  return tokens;
}

export function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const Tag = (`h${level + 1}` as 'h2' | 'h3' | 'h4'); // h1 in MD → h2 in card
      blocks.push(<Tag key={key++}>{renderInline(text, `h${key}`)}</Tag>);
      i++;
      continue;
    }

    // Bullet list
    if (/^[-*]\s+/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*[-*]\s+/, '');
        items.push(<li key={items.length}>{renderInline(itemText, `li${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(<ul key={key++}>{items}</ul>);
      continue;
    }

    // Paragraph: gather until blank or next block
    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const nxt = lines[i].trim();
      if (!nxt || /^(#{1,3})\s+/.test(nxt) || /^[-*]\s+/.test(nxt)) break;
      paraLines.push(nxt);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(paraLines.join(' '), `p${key}`)}</p>);
  }

  return blocks;
}
