import { describe, expect, it } from "vitest";
import { FINDERS, FINDER_VENDORS, parseVendors, spreadAcrossVendors } from "../../src/finders/run";
import type { AtsVendor } from "../../src/finders/types";

describe("finder registry", () => {
  it("covers the eight vendors the spec names and nothing else", () => {
    expect(FINDER_VENDORS).toEqual([
      "ashby",
      "greenhouse",
      "lever",
      "personio",
      "recruitee",
      "smartrecruiters",
      "workday",
      "yc",
    ]);
    // `other` is rows with no ATS this repo can read; there is no finder for it.
    expect(FINDERS.other).toBeUndefined();
    for (const vendor of FINDER_VENDORS) {
      expect(FINDERS[vendor]!.vendor).toBe(vendor);
    }
  });
});

describe("parseVendors", () => {
  it("accepts a known subset and normalises it", () => {
    expect(parseVendors("greenhouse, LEVER ,greenhouse")).toEqual(["greenhouse", "lever"]);
    expect(parseVendors(undefined)).toBeUndefined();
  });

  it("accepts workday alongside the other vendors", () => {
    expect(parseVendors("greenhouse,workday")).toEqual(["greenhouse", "workday"]);
  });

  it("rejects an unknown vendor by name", () => {
    expect(() => parseVendors("greenhouse,bamboohr")).toThrow(/bamboohr/);
  });
});

describe("spreadAcrossVendors", () => {
  const rows = (vendor: AtsVendor, n: number) =>
    Array.from({ length: n }, (_, i) => ({ atsVendor: vendor, id: `${vendor}-${i}` }));

  it("shares the cap between vendors instead of taking a prefix", () => {
    const all = [...rows("ashby", 10), ...rows("greenhouse", 10), ...rows("lever", 10)];
    const picked = spreadAcrossVendors(all, 6);
    expect(picked).toHaveLength(6);
    expect(picked.filter((r) => r.atsVendor === "ashby")).toHaveLength(2);
    expect(picked.filter((r) => r.atsVendor === "greenhouse")).toHaveLength(2);
    expect(picked.filter((r) => r.atsVendor === "lever")).toHaveLength(2);
    // Deterministic: each vendor contributes its own rows in order.
    expect(picked.map((r) => r.id)).toEqual([
      "ashby-0",
      "greenhouse-0",
      "lever-0",
      "ashby-1",
      "greenhouse-1",
      "lever-1",
    ]);
  });

  it("spends a vendor's unused share on the others", () => {
    const picked = spreadAcrossVendors([...rows("yc", 1), ...rows("greenhouse", 10)], 5);
    expect(picked.filter((r) => r.atsVendor === "yc")).toHaveLength(1);
    expect(picked.filter((r) => r.atsVendor === "greenhouse")).toHaveLength(4);
  });

  it("passes everything through when there is no cap or nothing to cap", () => {
    const all = rows("lever", 3);
    expect(spreadAcrossVendors(all)).toBe(all);
    expect(spreadAcrossVendors(all, 0)).toBe(all);
    expect(spreadAcrossVendors(all, 99)).toBe(all);
  });
});
