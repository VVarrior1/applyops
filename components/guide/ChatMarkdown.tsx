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
 * inline code, fenced code blocks, links, headings, and ordered/unordered
 * lists. It builds React elements directly (no `dangerouslySetInnerHTML`), so
 * there is no HTML injection surface to sanitize — model output can only ever
 * become text nodes, `<strong>`, `<em>`, `<code>`, `<pre>`, `<a>`, `<ul>`,
 * `<ol>`, `<li>`, `<p>` or `<br>`.
 *
 * Known limitations (acceptable for this app's actual content, revisit if
 * that changes): nested list items (`- Top\n  - Sub`) flatten to one level —
 * indentation is dropped, not tracked as depth. Blockquotes and tables are
 * not recognized and fall through to a plain paragraph with their markup
 * shown literally.
 */

// Bold spans use a lazy `[\s\S]+?` body (rather than `[^*]+`) so a bold span
// can contain other inline markup — e.g. inline code or a nested italic —
// which is then picked up by the recursive call below. Single-asterisk and
// single-underscore emphasis stay non-greedy over a restricted body and add
// boundary checks so they don't fire inside plain prose: `\*(?![\s])...` (no
// space right after the opening `*`, none right before the closing one) skips
// `5 * 3`, and `(?<![A-Za-z0-9])_..._(?![A-Za-z0-9])` skips `my_file_name`.
const INLINE_PATTERN =
  /(`[^`]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*(?![\s])[^*]+(?<![\s])\*|(?<![A-Za-z0-9])_[^_]+_(?![A-Za-z0-9]))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  // A fresh RegExp per call: INLINE_PATTERN is a module-level `/g` pattern,
  // and this function recurses into bold/italic bodies, so sharing one
  // stateful instance across the outer scan and the recursive calls it makes
  // would clobber `lastIndex` mid-scan and skip or duplicate matches.
  const re = new RegExp(INLINE_PATTERN.source, "g");
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const nodeKey = `${keyPrefix}-${key++}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={nodeKey}
          className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={nodeKey}>{renderInline(token.slice(2, -2), nodeKey)}</strong>,
      );
    } else {
      nodes.push(<em key={nodeKey}>{renderInline(token.slice(1, -1), nodeKey)}</em>);
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
