import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProbeResponse,
  namesLooselyMatch,
  probeUrlFor,
  probeVendorSlug,
  slugCandidates,
} from "../../src/finders/discover";

afterEach(() => vi.unstubAllGlobals());

describe("slugCandidates", () => {
  it("Neo Financial -> concatenated and hyphenated forms", () => {
    const candidates = slugCandidates("Neo Financial");
    expect(candidates).toContain("neofinancial");
    expect(candidates).toContain("neo-financial");
  });

  it("1Password -> 1password", () => {
    expect(slugCandidates("1Password")).toContain("1password");
  });

  it("D2L -> d2l", () => {
    expect(slugCandidates("D2L")).toContain("d2l");
  });

  it("Shareworks (Solium) handles parentheses without crashing", () => {
    const candidates = slugCandidates("Shareworks (Solium)");
    // The base name and the parenthetical are both offered as candidates...
    expect(candidates).toContain("shareworks");
    expect(candidates).toContain("solium");
    // ...as is the combined form.
    expect(candidates).toContain("shareworks-solium");
    expect(candidates.some((c) => c.includes("shareworks") && c.includes("solium"))).toBe(true);
    // Nothing leaks unbalanced punctuation or empty strings.
    for (const c of candidates) {
      expect(c).not.toMatch(/[()]/);
      expect(c.trim()).not.toBe("");
    }
  });

  it("strips a trailing legal-entity suffix as an extra candidate, keeping the unstripped form too", () => {
    const candidates = slugCandidates("Absorb Software Inc");
    expect(candidates).toContain("absorbsoftware");
    expect(candidates).toContain("absorbsoftwareinc");
  });

  it("adds a domain-hint candidate distinct from the name-derived ones", () => {
    const candidates = slugCandidates("Circle Cardiovascular Imaging", "circlecvi.com");
    expect(candidates).toContain("circlecvi");
    expect(candidates).toContain("circlecardiovascularimaging");
  });

  it("never returns empty or whitespace-only candidates", () => {
    for (const name of ["Neo Financial", "1Password", "D2L", "Shareworks (Solium)", "  ", "Æ"]) {
      for (const c of slugCandidates(name)) {
        expect(c.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("probeUrlFor", () => {
  it("builds the public list endpoint for each vendor", () => {
    expect(probeUrlFor("greenhouse", "acme")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
    );
    expect(probeUrlFor("lever", "acme")).toBe("https://api.lever.co/v0/postings/acme?mode=json");
    expect(probeUrlFor("ashby", "acme")).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/acme",
    );
    expect(probeUrlFor("recruitee", "acme")).toBe("https://acme.recruitee.com/api/offers");
    expect(probeUrlFor("smartrecruiters", "acme")).toBe(
      "https://api.smartrecruiters.com/v1/companies/acme/postings",
    );
  });
});

describe("classifyProbeResponse", () => {
  it("200 with a non-empty jobs/postings/offers/content array is a hit", () => {
    expect(classifyProbeResponse("greenhouse", 200, { jobs: [{ id: 1 }, { id: 2 }] })).toEqual({
      hit: true,
      jobCount: 2,
    });
    expect(classifyProbeResponse("ashby", 200, { jobs: [{ id: 1 }] })).toEqual({
      hit: true,
      jobCount: 1,
    });
    expect(classifyProbeResponse("lever", 200, [{ id: "a" }, { id: "b" }, { id: "c" }])).toEqual({
      hit: true,
      jobCount: 3,
    });
    expect(classifyProbeResponse("recruitee", 200, { offers: [{ id: 1 }] })).toEqual({
      hit: true,
      jobCount: 1,
    });
    expect(
      classifyProbeResponse("smartrecruiters", 200, { content: [{ id: "1" }, { id: "2" }] }),
    ).toEqual({ hit: true, jobCount: 2 });
  });

  it("200 with an empty array is a miss, not a hit", () => {
    expect(classifyProbeResponse("greenhouse", 200, { jobs: [] })).toEqual({ hit: false });
    expect(classifyProbeResponse("lever", 200, [])).toEqual({ hit: false });
    expect(classifyProbeResponse("recruitee", 200, { offers: [] })).toEqual({ hit: false });
    expect(classifyProbeResponse("smartrecruiters", 200, { content: [] })).toEqual({
      hit: false,
    });
  });

  it("a non-200 status is always a miss, even with a well-formed body", () => {
    expect(classifyProbeResponse("greenhouse", 404, { jobs: [{ id: 1 }] })).toEqual({
      hit: false,
    });
    expect(classifyProbeResponse("greenhouse", 500, { jobs: [{ id: 1 }] })).toEqual({
      hit: false,
    });
  });

  it("a malformed or unexpected body shape is a miss", () => {
    expect(classifyProbeResponse("greenhouse", 200, { notJobs: [1, 2] })).toEqual({ hit: false });
    expect(classifyProbeResponse("greenhouse", 200, null)).toEqual({ hit: false });
    expect(classifyProbeResponse("lever", 200, { postings: [1] })).toEqual({ hit: false });
  });
});

describe("namesLooselyMatch", () => {
  it("accepts identical, substring, and legal-suffix-only differences", () => {
    expect(namesLooselyMatch("Genetec", "genetec")).toBe(true);
    expect(namesLooselyMatch("EY", "EY Canada")).toBe(true);
    expect(namesLooselyMatch("Neo Financial", "Neo Financial Inc")).toBe(true);
    // A domain-hint-folded expected name still recognizes the product brand.
    expect(namesLooselyMatch("Ceridian dayforce", "Dayforce")).toBe(true);
  });

  it("rejects two different real companies that merely share one word", () => {
    expect(namesLooselyMatch("Solera Holdings", "Solera Health")).toBe(false);
    expect(namesLooselyMatch("Parkland Corporation", "Parkland Animal Clinic")).toBe(false);
  });
});

describe("classifyProbeResponse with expectedName", () => {
  it("keeps a hit when the response's company name loosely matches", () => {
    expect(
      classifyProbeResponse(
        "greenhouse",
        200,
        { jobs: [{ id: 1, company_name: "Genetec" }] },
        "Genetec",
      ),
    ).toEqual({ hit: true, jobCount: 1 });
  });

  it("turns a hit into a miss when the response's company name clearly disagrees", () => {
    expect(
      classifyProbeResponse(
        "greenhouse",
        200,
        { jobs: [{ id: 1, company_name: "Solera Health" }] },
        "Solera Holdings",
      ),
    ).toEqual({ hit: false });
    expect(
      classifyProbeResponse(
        "smartrecruiters",
        200,
        { content: [{ id: "1", company: { name: "Parkland Animal Clinic" } }] },
        "Parkland Corporation",
      ),
    ).toEqual({ hit: false });
  });

  it("cannot check vendors with no per-posting company name (lever, ashby) — trusts the slug", () => {
    expect(
      classifyProbeResponse("lever", 200, [{ id: "a" }], "Some Totally Different Name"),
    ).toEqual({ hit: true, jobCount: 1 });
  });
});

describe("probeVendorSlug (fake fetch responses)", () => {
  it("200 + non-empty jobs -> hit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ jobs: [{ id: 1 }, { id: 2 }] }), { status: 200 })),
    );
    expect(await probeVendorSlug("greenhouse", "acme")).toEqual({ hit: true, jobCount: 2 });
  });

  it("200 + empty jobs -> miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })),
    );
    expect(await probeVendorSlug("greenhouse", "acme")).toEqual({ hit: false });
  });

  it("404 -> miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    expect(await probeVendorSlug("lever", "acme")).toEqual({ hit: false });
  });

  it("a timeout/network error -> miss, never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "TimeoutError");
      }),
    );
    await expect(probeVendorSlug("ashby", "acme")).resolves.toEqual({ hit: false });
  });

  it("malformed JSON body -> miss, never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>not json</html>", { status: 200 })),
    );
    await expect(probeVendorSlug("recruitee", "acme")).resolves.toEqual({ hit: false });
  });

  it("a known impostor tenant is always a miss, without even calling fetch", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ offers: [{ id: 1 }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    // recruitee:google was verified by hand to be a demo/placeholder tenant
    // impersonating Google (see the KNOWN_IMPOSTOR_TENANTS doc comment).
    await expect(probeVendorSlug("recruitee", "google")).resolves.toEqual({ hit: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
