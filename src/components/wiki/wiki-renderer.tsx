'use client';

import React, { useState } from 'react';
import { IconCheck, IconCopy, IconExternalLink } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

/**
 * Wikilink-aware markdown renderer for the dashboard /wiki page.
 *
 * Mirrors the shape of @/lib/render-markdown.tsx but extends inline parsing
 * to handle [[wikilink]] references and routes them through onWikilink. We
 * keep this purpose-specific so the global renderMarkdown stays simple.
 * Porcelain Signal (2026-09-29): reading type (15px / 1.7), Sora headings,
 * wikilinks as cobalt chips, code blocks with a header and copy button.
 */

interface WikiRendererProps {
  text: string;
  onWikilink: (slug: string) => void;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const lines = code.split('\n');
  return (
    <div className="my-4 overflow-hidden rounded-[14px] border border-[#E4E8F0] bg-[#F8F9FB] dark:border-border dark:bg-inset">
      <div className="flex h-9 items-center justify-between border-b border-[#E4E8F0] pl-4 pr-2 dark:border-border">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-label">{lang || 'code'}</span>
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy code'}
          title="Copy code"
          onClick={() => {
            navigator.clipboard?.writeText(code)
              .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
              .catch(() => {});
          }}
          className={cn(
            'flex size-[26px] items-center justify-center rounded-lg transition-colors',
            copied ? 'bg-healthy-bg text-healthy' : 'text-muted-foreground hover:bg-card hover:text-foreground',
          )}
        >
          {copied ? <IconCheck size={14} stroke={2} /> : <IconCopy size={14} stroke={1.7} />}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.75]">
        {lines.map((l, i) => (
          <span key={i} className="flex gap-3.5">
            <span aria-hidden="true" className="w-5 shrink-0 select-none text-right text-[#8A93A6]">{i + 1}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{l || ' '}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

export function WikiRenderer({ text, onWikilink }: WikiRendererProps) {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;
  const key = () => keyCounter++;

  const renderInline = (line: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    // Order: wikilinks before plain links so [[ doesn't get eaten by [
    const re =
      /(\[\[([^\]]+)\]\]|\*\*(.+?)\*\*|\*([^*]+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      if (m[2] !== undefined) {
        const slug = m[2].trim();
        // <a> instead of <button>: HTML allows <a> inside <p> but not <button>.
        // href="#" + preventDefault keeps the link semantic without navigating.
        parts.push(
          <a
            key={key()}
            href="#"
            role="link"
            onClick={(e) => {
              e.preventDefault();
              onWikilink(slug);
            }}
            className="cursor-pointer rounded-md bg-accent px-1.5 py-px font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {slug}
          </a>,
        );
      } else if (m[3] !== undefined) {
        parts.push(<strong key={key()} className="font-semibold">{m[3]}</strong>);
      } else if (m[4] !== undefined) {
        parts.push(<em key={key()}>{m[4]}</em>);
      } else if (m[5] !== undefined) {
        parts.push(
          <code
            key={key()}
            className="rounded-md bg-inset px-1.5 py-0.5 font-mono text-[13px]"
          >
            {m[5]}
          </code>,
        );
      } else if (m[6] !== undefined) {
        parts.push(
          <a
            key={key()}
            href={m[7]}
            className="font-medium text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {m[6]}
            <IconExternalLink size={12} stroke={2} className="ml-0.5 inline-block align-[-1px]" aria-hidden="true" />
          </a>,
        );
      }
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts.length === 1 ? parts[0] : <>{parts}</>;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      nodes.push(<CodeBlock key={key()} lang={lang} code={codeLines.join('\n')} />);
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={key()} className="my-5 border-hairline" />);
      i++;
      continue;
    }

    const h3 = line.match(/^### (.+)/);
    if (h3) {
      nodes.push(
        <h3 key={key()} className="mb-1.5 mt-5 text-[15.5px] font-semibold">
          {renderInline(h3[1])}
        </h3>,
      );
      i++;
      continue;
    }
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      nodes.push(
        <h2
          key={key()}
          className="mb-2 mt-6 font-heading text-[19px] font-semibold tracking-[-0.01em]"
        >
          {renderInline(h2[1])}
        </h2>,
      );
      i++;
      continue;
    }
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      nodes.push(
        <h1 key={key()} className="mb-2 mt-6 font-heading text-[22px] font-semibold tracking-[-0.02em]">
          {renderInline(h1[1])}
        </h1>,
      );
      i++;
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(
          <li key={key()} className="pl-1 text-[15px] leading-[1.7]">
            {renderInline(lines[i].replace(/^[-*] /, ''))}
          </li>,
        );
        i++;
      }
      nodes.push(
        <ul key={key()} className="my-1.5 list-disc space-y-0.5 pl-6 marker:text-label">
          {items}
        </ul>,
      );
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(
          <li key={key()} className="pl-1 text-[15px] leading-[1.7]">
            {renderInline(lines[i].replace(/^\d+\. /, ''))}
          </li>,
        );
        i++;
      }
      nodes.push(
        <ol key={key()} className="my-1.5 list-decimal space-y-0.5 pl-6 marker:text-label">
          {items}
        </ol>,
      );
      continue;
    }

    if (line.trim() === '') {
      nodes.push(<div key={key()} className="h-3" />);
      i++;
      continue;
    }

    nodes.push(
      <p key={key()} className="text-[15px] leading-[1.7]">
        {renderInline(line)}
      </p>,
    );
    i++;
  }

  return <>{nodes}</>;
}
