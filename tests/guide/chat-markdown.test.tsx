import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "@/components/guide/ChatMarkdown";

/**
 * Renders with `react-dom/server` rather than a DOM-testing library: the
 * component builds React elements directly (no effects, no interactivity),
 * so static markup is enough to assert on and needs no jsdom environment
 * (see vitest.config.ts — this project's tests run under `node`).
 */
function render(text: string): string {
  return renderToStaticMarkup(<ChatMarkdown text={text} />);
}

describe("ChatMarkdown", () => {
  it("renders bold", () => {
    expect(render("**bold**")).toContain("<strong>bold</strong>");
  });

  it("renders italic", () => {
    expect(render("*italic*")).toContain("<em>italic</em>");
  });

  it("renders inline code", () => {
    const html = render("`code`");
    expect(html).toContain("<code");
    expect(html).toContain(">code</code>");
  });

  it("renders an unordered list", () => {
    const html = render("- one\n- two");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("renders an ordered list", () => {
    const html = render("1. first\n2. second");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });

  it("renders a fenced code block", () => {
    const html = render("```\nconst x = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("const x = 1;");
  });

  it("renders bold containing inline code", () => {
    const html = render("**Use `TN status`**");
    expect(html).toContain("<strong>");
    expect(html).toContain("<code");
    expect(html).toContain(">TN status</code>");
  });

  it("renders a markdown link with a safe href", () => {
    const html = render("See [Job Bank](https://jobbank.gc.ca) for wage data.");
    expect(html).toContain('href="https://jobbank.gc.ca"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">Job Bank</a>");
  });

  it("refuses to render a non-http(s) link scheme as an href", () => {
    const html = render("[click me](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).toContain("[click me](javascript:alert(1))");
  });

  it("renders a heading", () => {
    const html = render("## Your biggest gap");
    expect(html).not.toContain("##");
    expect(html).toContain("Your biggest gap");
    expect(html).toContain("font-semibold");
  });

  it("does not treat multiplication as italic", () => {
    expect(render("5 * 3")).not.toContain("<em>");
  });

  it("does not treat a snake_case identifier as italic", () => {
    expect(render("my_file_name")).not.toContain("<em>");
  });

  it("leaves an unclosed bold marker as literal text", () => {
    const html = render("**oops");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("**oops");
  });

  // CommonMark treats a line starting with a number+period as an ordered
  // list item, the same way this parser does — documented here as an
  // intentional tradeoff, not a bug: prose that happens to start a
  // paragraph with a year followed by a period reads as a one-item list,
  // and everything before the first `. ` is dropped rather than shown.
  it("treats a leading 'YYYY. ' as an ordered list start (documented CommonMark-style tradeoff)", () => {
    const html = render("2024. That was the year you graduated.");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>That was the year you graduated.</li>");
    expect(html).not.toContain("2024.");
  });
});
