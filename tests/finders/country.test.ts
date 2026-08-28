import { describe, expect, it } from "vitest";
import { detectCountries, COUNTRY_OPTIONS } from "../../src/finders/country";

describe("detectCountries", () => {
  it.each([
    ["Remote - Mexico", ["MX"]],
    ["Remote, Singapore", ["SG"]],
    ["Remote - Argentina; Remote - Colombia", ["AR", "CO"]],
    ["Poland - Remote", ["PL"]],
    ["Remote - USA", ["US"]],
    ["Remote (US or Canada)", ["US", "CA"]],
    ["Calgary, AB", ["CA"]],
    ["Toronto, Ontario, Canada", ["CA"]],
    ["Vancouver, British Columbia", ["CA"]],
    ["San Francisco, CA", ["US"]],
    ["New York, NY, United States", ["US"]],
    ["Austin, Texas", ["US"]],
    ["London, UK", ["GB"]],
    ["Berlin, Germany", ["DE"]],
    ["Bengaluru, India", ["IN"]],
    ["Remote - Brazil; Remote - Costa Rica", ["BR", "CR"]],
  ])("%s → %j", (location, expected) => {
    expect(detectCountries(location)).toEqual(expected);
  });

  it("returns [] when no country can be determined", () => {
    expect(detectCountries("Remote")).toEqual([]);
    expect(detectCountries("EMEA")).toEqual([]);
    expect(detectCountries("Worldwide")).toEqual([]);
    expect(detectCountries(null)).toEqual([]);
    expect(detectCountries("")).toEqual([]);
  });

  it("does not confuse the CA state code with Canada", () => {
    expect(detectCountries("Los Angeles, CA")).toEqual(["US"]);
    expect(detectCountries("Canada")).toEqual(["CA"]);
  });

  it("dedupes and preserves first-seen order", () => {
    expect(detectCountries("Remote - United States; New York, NY; Toronto, ON")).toEqual(["US", "CA"]);
  });

  it("falls back to the description when the location is empty", () => {
    expect(detectCountries("Remote", "This role is open to candidates located in Canada only.")).toEqual(["CA"]);
  });

  it("exposes a stable options list for the UI", () => {
    const codes = COUNTRY_OPTIONS.map((o) => o.code);
    expect(codes).toContain("CA");
    expect(codes).toContain("US");
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("world coverage and unrecognized geography", () => {
  it.each([
    ["Tiranë, Tirana County, Albania", ["AL"]],
    ["Limassol, Limassol, Cyprus", ["CY"]],
    ["Kaunas Office", ["LT"]],
    ["London", ["GB"]],
    ["London, ON", ["CA"]],
    ["London, Ontario, Canada", ["CA"]],
    ["Paris, France", ["FR"]],
    ["Bogotá", ["CO"]],
    ["Ho Chi Minh City", ["VN"]],
  ])("%s → %j", async (location, expected) => {
    const { detectCountries } = await import("../../src/finders/country");
    expect(detectCountries(location)).toEqual(expected);
  });

  it("flags concrete-but-unmapped places, not remote-ish ones", async () => {
    const { hasUnrecognizedGeography, isRemoteishLocation } = await import("../../src/finders/country");
    expect(isRemoteishLocation("Remote")).toBe(true);
    expect(isRemoteishLocation("Anywhere in the world")).toBe(true);
    expect(isRemoteishLocation(null)).toBe(true);
    expect(isRemoteishLocation("Ouagadougou Office")).toBe(false);
    expect(hasUnrecognizedGeography("Ouagadougou Office", [])).toBe(true);
    expect(hasUnrecognizedGeography("Remote", [])).toBe(false);
    expect(hasUnrecognizedGeography("Tiranë, Albania", ["AL"])).toBe(false);
  });
});

describe("explicit geography beats city guesses", () => {
  it("Waterloo, Nebraska is US; Waterloo, ON is Canada; bare Waterloo is Canada", async () => {
    const { detectCountries } = await import("../../src/finders/country");
    expect(detectCountries("Waterloo, Nebraska, United States")).toEqual(["US"]);
    expect(detectCountries("Waterloo, ON")).toEqual(["CA"]);
    expect(detectCountries("Waterloo")).toEqual(["CA"]);
  });
});
