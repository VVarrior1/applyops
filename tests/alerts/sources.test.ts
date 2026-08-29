import { describe, it, expect } from "vitest";
import { parseSimplify, parseSpeedyapply, type AlertSource } from "@/src/alerts/sources";

const jsonSource: AlertSource = {
  id: "simplify-newgrad",
  kind: "json",
  url: "https://example.test/listings.json",
  repo: "SimplifyJobs/New-Grad-Positions",
  enabled: true,
};
const mdSource: AlertSource = { ...jsonSource, id: "speedyapply", kind: "markdown" };

describe("parseSimplify", () => {
  const record = {
    id: "abc-123",
    company_name: "Yelp",
    title: "Software Engineer",
    url: "https://example.test/apply",
    active: true,
    is_visible: true,
    date_posted: 1767841111,
    locations: ["Toronto, ON"],
    category: "Software",
    sponsorship: "Other",
  };

  it("maps a record onto the normalised shape", () => {
    const [out] = parseSimplify(jsonSource, [record]);
    expect(out).toMatchObject({
      externalKey: "simplify-newgrad:abc-123",
      company: "Yelp",
      title: "Software Engineer",
      locations: ["Toronto, ON"],
    });
    expect(out.postedAt?.getTime()).toBe(1767841111 * 1000);
  });

  // ~83% of the 19k records in the live file are inactive history.
  it("drops inactive and hidden postings", () => {
    expect(parseSimplify(jsonSource, [{ ...record, active: false }])).toHaveLength(0);
    expect(parseSimplify(jsonSource, [{ ...record, is_visible: false }])).toHaveLength(0);
  });

  it("drops records with a non-http url or missing fields", () => {
    expect(parseSimplify(jsonSource, [{ ...record, url: "javascript:alert(1)" }])).toHaveLength(0);
    expect(parseSimplify(jsonSource, [{ id: "x" }])).toHaveLength(0);
  });

  it("survives a non-array payload rather than throwing mid-run", () => {
    expect(parseSimplify(jsonSource, { jobs: [] })).toEqual([]);
    expect(parseSimplify(jsonSource, null)).toEqual([]);
  });
});

describe("parseSpeedyapply", () => {
  const md = [
    "| Company | Role | Location | Application | Age |",
    "| --- | --- | --- | --- | --- |",
    '| **[Shopify](https://x.test/c)** | Backend Engineer | Toronto, ON | <a href="https://apply.test/1"><img src="x"></a> | 0d |',
    '| **[Ada](https://x.test/c)** | Data Analyst | Remote<br/>Canada | <a href="https://apply.test/2"><img src="x"></a> | 1d |',
  ].join("\n");

  it("pulls company, role, location and the apply link out of a table row", () => {
    const out = parseSpeedyapply(mdSource, md);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      company: "Shopify",
      title: "Backend Engineer",
      url: "https://apply.test/1",
      postedAt: null,
    });
    expect(out[1].locations[0]).toContain("Canada");
  });

  it("skips the header row and rows with no apply link", () => {
    const out = parseSpeedyapply(mdSource, "| Company | Role | Location | Application | Age |\n| **[X](y)** | Dev | Toronto | no-link | 0d |");
    expect(out).toHaveLength(0);
  });

  it("dedupes rows that point at the same posting", () => {
    expect(parseSpeedyapply(mdSource, `${md}\n${md.split("\n")[2]}`)).toHaveLength(2);
  });
});
