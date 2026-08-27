import { describe, it, expect } from "vitest";
import { redactCompanies, roleFamily } from "../../src/funnel/redact";

describe("redactCompanies", () => {
  it("plan Task 14 Step 1: Stripe, Stripe, Shopify -> Company #1, Company #1, Company #2", () => {
    const result = redactCompanies([
      { company: "Stripe" },
      { company: "Stripe" },
      { company: "Shopify" },
    ]);
    expect(result).toEqual(["Company #1", "Company #1", "Company #2"]);
  });

  it("numbers by order of first appearance, not alphabetically", () => {
    const result = redactCompanies([
      { company: "Zebra Corp" },
      { company: "Acme Inc" },
      { company: "Zebra Corp" },
      { company: "Acme Inc" },
      { company: "Midco" },
    ]);
    expect(result).toEqual(["Company #1", "Company #2", "Company #1", "Company #2", "Company #3"]);
  });

  it("treats the same name case/whitespace-insensitively as the same company", () => {
    const result = redactCompanies([
      { company: "Stripe" },
      { company: " stripe " },
      { company: "STRIPE" },
    ]);
    expect(result).toEqual(["Company #1", "Company #1", "Company #1"]);
  });

  it("returns an empty array for no input", () => {
    expect(redactCompanies([])).toEqual([]);
  });
});

describe("roleFamily", () => {
  it("buckets common software titles", () => {
    expect(roleFamily("Software Engineer")).toBe("Software Engineering");
    expect(roleFamily("Senior Backend Engineer")).toBe("Backend");
    expect(roleFamily("Frontend Developer")).toBe("Frontend");
    expect(roleFamily("Full Stack Engineer")).toBe("Full Stack");
  });

  it("buckets data, product, design, devops, qa and security roles", () => {
    expect(roleFamily("Data Science Intern (2026 Start)")).toBe("Data / ML");
    expect(roleFamily("Data Analyst")).toBe("Data / Analytics");
    expect(roleFamily("Product Manager")).toBe("Product");
    expect(roleFamily("UX Designer")).toBe("Design");
    expect(roleFamily("DevOps Engineer")).toBe("DevOps / Infra");
    expect(roleFamily("QA Engineer")).toBe("QA / Test");
    expect(roleFamily("Security Engineer")).toBe("Security");
  });

  it("falls back to 'Other' for titles with no recognized family, including empty/unknown titles", () => {
    expect(roleFamily("")).toBe("Other");
    expect(roleFamily("Unknown position (v1 job 1762767971481-ifmwwur7a)")).toBe("Other");
  });

  it("is not fooled by 'engineer' inside a more specific bucket's title", () => {
    // Must resolve to DevOps / Infra, not the generic "engineer" catch-all.
    expect(roleFamily("Site Reliability Engineer")).toBe("DevOps / Infra");
  });
});
