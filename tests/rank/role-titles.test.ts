import { describe, expect, it } from "vitest";
import { roleTitlePattern, roleTitlePatternSource, titleMatchesRoles } from "../../src/rank/role-titles";

describe("roleTitlePattern / titleMatchesRoles", () => {
  it("returns null for an empty roles list, and titleMatchesRoles treats that as 'match anything'", () => {
    expect(roleTitlePattern([])).toBeNull();
    expect(titleMatchesRoles("Senior Accountant", [])).toBe(true);
  });

  it("returns null when every role given is unrecognized, same fallback as empty", () => {
    expect(roleTitlePattern(["Sales"])).toBeNull();
    expect(titleMatchesRoles("Account Executive", ["Sales"])).toBe(true);
  });

  it("Backend matches 'back-end', 'platform', 'api', 'server', 'infrastructure' titles", () => {
    expect(titleMatchesRoles("Backend Engineer", ["Backend"])).toBe(true);
    expect(titleMatchesRoles("Back-End Developer", ["Backend"])).toBe(true);
    expect(titleMatchesRoles("Platform Engineer", ["Backend"])).toBe(true);
    expect(titleMatchesRoles("API Developer", ["Backend"])).toBe(true);
    expect(titleMatchesRoles("Infrastructure Engineer", ["Backend"])).toBe(true);
    expect(titleMatchesRoles("Product Designer", ["Backend"])).toBe(false);
  });

  it("ML/AI matches whole-word 'ml'/'ai' but not substrings like 'html' or 'air'", () => {
    expect(titleMatchesRoles("ML Engineer", ["ML/AI"])).toBe(true);
    expect(titleMatchesRoles("AI Research Scientist", ["ML/AI"])).toBe(true);
    expect(titleMatchesRoles("Machine Learning Engineer", ["ML/AI"])).toBe(true);
    expect(titleMatchesRoles("LLM Engineer", ["ML/AI"])).toBe(true);
    expect(titleMatchesRoles("HTML Developer", ["ML/AI"])).toBe(false);
    expect(titleMatchesRoles("Air Traffic Controller", ["ML/AI"])).toBe(false);
  });

  it("SWE matches 'software engineer/developer', 'swe', whole-word 'sde', and titles ending in 'engineer'", () => {
    expect(titleMatchesRoles("Software Engineer I", ["SWE"])).toBe(true);
    expect(titleMatchesRoles("Software Developer", ["SWE"])).toBe(true);
    expect(titleMatchesRoles("SWE New Grad", ["SWE"])).toBe(true);
    expect(titleMatchesRoles("SDE I", ["SWE"])).toBe(true);
    expect(titleMatchesRoles("Data Engineer", ["SWE"])).toBe(true); // ends in "engineer"
    expect(titleMatchesRoles("Sales Associate", ["SWE"])).toBe(false);
  });

  it("Data matches 'data engineer/scientist/analyst' and 'analytics'", () => {
    expect(titleMatchesRoles("Data Engineer", ["Data"])).toBe(true);
    expect(titleMatchesRoles("Data Scientist", ["Data"])).toBe(true);
    expect(titleMatchesRoles("Data Analyst", ["Data"])).toBe(true);
    expect(titleMatchesRoles("Analytics Associate", ["Data"])).toBe(true);
    expect(titleMatchesRoles("Marketing Manager", ["Data"])).toBe(false);
  });

  it("DevOps/SRE matches 'devops', 'sre', 'site reliability', 'cloud engineer', 'platform engineer'", () => {
    expect(titleMatchesRoles("DevOps Engineer", ["DevOps/SRE"])).toBe(true);
    expect(titleMatchesRoles("SRE II", ["DevOps/SRE"])).toBe(true);
    expect(titleMatchesRoles("Site Reliability Engineer", ["DevOps/SRE"])).toBe(true);
    expect(titleMatchesRoles("Cloud Engineer", ["DevOps/SRE"])).toBe(true);
    expect(titleMatchesRoles("Graphic Designer", ["DevOps/SRE"])).toBe(false);
  });

  it("Mobile matches 'ios', 'android', 'mobile', 'react native', 'flutter'", () => {
    expect(titleMatchesRoles("iOS Engineer", ["Mobile"])).toBe(true);
    expect(titleMatchesRoles("Android Developer", ["Mobile"])).toBe(true);
    expect(titleMatchesRoles("Mobile Engineer", ["Mobile"])).toBe(true);
    expect(titleMatchesRoles("React Native Developer", ["Mobile"])).toBe(true);
    expect(titleMatchesRoles("Flutter Developer", ["Mobile"])).toBe(true);
    expect(titleMatchesRoles("Backend Engineer", ["Mobile"])).toBe(false);
  });

  it("Frontend matches 'front-end', 'web developer', 'ui engineer', 'react'; Full-stack matches 'full-stack'", () => {
    expect(titleMatchesRoles("Frontend Engineer", ["Frontend"])).toBe(true);
    expect(titleMatchesRoles("Front-End Developer", ["Frontend"])).toBe(true);
    expect(titleMatchesRoles("React Developer", ["Frontend"])).toBe(true);
    expect(titleMatchesRoles("Full-Stack Engineer", ["Full-stack"])).toBe(true);
    expect(titleMatchesRoles("Fullstack Developer", ["Full-stack"])).toBe(true);
    expect(titleMatchesRoles("Backend Engineer", ["Frontend"])).toBe(false);
  });

  it("combines multiple roles with OR", () => {
    expect(titleMatchesRoles("iOS Engineer", ["Backend", "Mobile"])).toBe(true);
    expect(titleMatchesRoles("Backend Engineer", ["Backend", "Mobile"])).toBe(true);
    expect(titleMatchesRoles("Marketing Manager", ["Backend", "Mobile"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(titleMatchesRoles("backend engineer", ["Backend"])).toBe(true);
    expect(titleMatchesRoles("BACKEND ENGINEER", ["Backend"])).toBe(true);
  });
});

describe("roleTitlePatternSource", () => {
  it("returns null under the same conditions as roleTitlePattern", () => {
    expect(roleTitlePatternSource([])).toBeNull();
    expect(roleTitlePatternSource(["Sales"])).toBeNull();
  });

  it("rewrites JS word-boundary \\b escapes to Postgres's \\y (ARE has no \\b word boundary)", () => {
    const source = roleTitlePatternSource(["ML/AI"]);
    expect(source).not.toBeNull();
    expect(source).not.toContain("\\b");
    expect(source).toContain("\\yml\\y");
    expect(source).toContain("\\yai\\y");
  });

  it("produces a source string usable to build the equivalent JS pattern's own alternation shape", () => {
    const source = roleTitlePatternSource(["Backend", "Mobile"]);
    expect(source).toBe("(?:back-?end|platform|api|server|infrastructure)|(?:ios|android|mobile|react native|flutter)");
  });
});
