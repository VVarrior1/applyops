import { Fragment, type ReactNode } from "react";

/**
 * Minimal, dependency-free markdown for chat replies.
 *
 * The chat prompt (`src/pipeline/prompts/chat.v1.md`) explicitly allows
 * markdown in assistant replies, but nothing rendered it — messages were
 * dumped as `whitespace-pre-wrap` plain text, so `**bold**`, `* bullet` and
 * `1. item` came through as literal punctuation.
 *
 * This covers exactly what the prompt actually produces: bold, italic,
 * inline code, fenced code blocks, and ordered/unordered lists. It builds
 * React elements directly (no `dangerouslySetInnerHTML`), so there is no HTML
 * injection surface to sanitize — model output can only ever become text
 * nodes, `<strong>`, `<em>`, `<code>`, `<pre>`, `<ul>`, `<ol>`, `<li>`, `<p>`
 * or `<br>`.
 */

const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={`${keyPrefix}-${key++}`}
          className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={`${keyPrefix}-${key++}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={`${keyPrefix}-${key++}`}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

const UL_ITEM = /^\s*[-*]\s+(.*)$/;
const OL_ITEM = /^\s*\d+\.\s+(.*)$/;
const FENCE = /^\s*```/;

export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence, if present
      blocks.push(
        <pre
          key={`b-${blockKey++}`}
          className="overflow-x-auto rounded-md bg-foreground/10 p-2 font-mono text-xs"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (UL_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = UL_ITEM.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      const key = blockKey++;
      blocks.push(
        <ul key={`b-${key}`} className="list-disc space-y-1 pl-5">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ul-${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (OL_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = OL_ITEM.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      const key = blockKey++;
      blocks.push(
        <ol key={`b-${key}`} className="list-decimal space-y-1 pl-5">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ol-${key}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !UL_ITEM.test(lines[i]) &&
      !OL_ITEM.test(lines[i]) &&
      !FENCE.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    const key = blockKey++;
    blocks.push(
      <p key={`b-${key}`}>
        {paraLines.map((l, idx) => (
          <Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInline(l, `p-${key}-${idx}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="space-y-2">{blocks}</div>;
}
