import React from 'react';
import {
  IconHierarchy,
  IconTooltip,
  IconObjectScan,
  IconGhost2,
  IconHandMove,
  IconZoomIn,
  IconFlipHorizontal,
} from '@tabler/icons-react';

/**
 * Minimal Markdown renderer for dashboard instructions.
 *
 * Supported:
 *   - ATX headings: # h1 (rendered as page heading), ## h2 (rendered as
 *     collapsible <details> section — first one `open` by default),
 *     ### h3 (in-section subheading).
 *   - Bullet lists: - or *
 *   - Inline: **bold**, *italic*, `code`, [link](url)
 *   - Inline icons via `:icon-<name>:` — see ICONS below for the available set.
 *
 * Not supported: nested lists, code fences, tables.
 */

// ── Icon registry ───────────────────────────────────────────────────────────

type TablerIconLike = React.FC<{ size?: number | string; className?: string }>;
const ICONS: Record<string, TablerIconLike> = {
  hierarchy: IconHierarchy,
  tooltip: IconTooltip,
  'object-scan': IconObjectScan,
  ghost: IconGhost2,
  'hand-move': IconHandMove,
  'zoom-in': IconZoomIn,
  'flip-horizontal': IconFlipHorizontal,
};

// ── Inline renderer ─────────────────────────────────────────────────────────

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const CODE_RE = /`([^`]+)`/g;
const ITALIC_RE = /(^|[^*])\*([^*\n]+)\*/g;
const ICON_RE = /:icon-([a-z0-9-]+):/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode {
  const slots: { marker: string; node: React.ReactNode }[] = [];
  const push = (node: React.ReactNode): string => {
    const marker = `\u0000${slots.length}\u0000`;
    slots.push({ marker, node });
    return marker;
  };

  let t = text;
  t = t.replace(ICON_RE, (raw, name: string) => {
    const Icon = ICONS[name];
    if (!Icon) return raw; // unknown icon name — leave literal
    return push(
      <Icon
        key={`${keyPrefix}-ic-${slots.length}`}
        size={14}
        className="home-instructions-icon"
      />,
    );
  });
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
  const out: React.ReactNode[] = [];
  for (const part of parts) {
    if (!part) continue;
    const slot = slots.find((s) => s.marker === part);
    out.push(slot ? slot.node : part);
  }
  return out;
}

// ── Block renderer ──────────────────────────────────────────────────────────

export function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split('\n');
  const top: React.ReactNode[] = [];
  type Group = { titleKey: number; title: React.ReactNode; content: React.ReactNode[] };
  let group: Group | null = null;
  let i = 0;
  let key = 0;
  let h2Count = 0;

  const push = (node: React.ReactNode) => {
    if (group) group.content.push(node);
    else top.push(node);
  };

  const flush = () => {
    if (!group) return;
    top.push(
      <details key={`d-${group.titleKey}`} open={h2Count === 1} className="home-spoiler">
        <summary>{group.title}</summary>
        <div className="home-spoiler-content">{group.content}</div>
      </details>,
    );
    group = null;
  };

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
      if (level === 1) {
        flush();
        top.push(<h2 key={key++}>{renderInline(text, `h${key}`)}</h2>);
      } else if (level === 2) {
        flush();
        h2Count++;
        group = {
          titleKey: key++,
          title: renderInline(text, `s${key}`),
          content: [],
        };
      } else {
        push(<h4 key={key++}>{renderInline(text, `h${key}`)}</h4>);
      }
      i++;
      continue;
    }

    // Bullet list
    if (/^[-*]\s+/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*[-*]\s+/, '');
        items.push(
          <li key={items.length}>{renderInline(itemText, `li${key}-${items.length}`)}</li>,
        );
        i++;
      }
      push(<ul key={key++}>{items}</ul>);
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
    push(<p key={key++}>{renderInline(paraLines.join(' '), `p${key}`)}</p>);
  }

  flush();
  return top;
}
