import { describe, it, expect } from "vitest";
import { isEmailAllowedPure } from "../../src/auth/allowlist";

describe("isEmailAllowedPure", () => {
  const opts = {
    ownerEmail: "Owner@Example.com",
    allowed: ["friend@example.com", "Second.Friend@Example.com"],
  };

  it("returns true for the owner email, case-insensitively", () => {
    expect(isEmailAllowedPure("owner@example.com", opts)).toBe(true);
    expect(isEmailAllowedPure("OWNER@EXAMPLE.COM", opts)).toBe(true);
    expect(isEmailAllowedPure("Owner@Example.com", opts)).toBe(true);
  });

  it("returns true for a listed email, case-insensitively", () => {
    expect(isEmailAllowedPure("friend@example.com", opts)).toBe(true);
    expect(isEmailAllowedPure("FRIEND@EXAMPLE.COM", opts)).toBe(true);
    expect(isEmailAllowedPure("second.friend@example.com", opts)).toBe(true);
  });

  it("returns false for an email that is neither the owner nor listed", () => {
    expect(isEmailAllowedPure("stranger@example.com", opts)).toBe(false);
  });

  it("returns false when the owner email is unset and the address isn't listed", () => {
    expect(
      isEmailAllowedPure("stranger@example.com", {
        ownerEmail: undefined,
        allowed: ["friend@example.com"],
      }),
    ).toBe(false);
  });

  it("tolerates surrounding whitespace on the input email", () => {
    expect(isEmailAllowedPure("  owner@example.com  ", opts)).toBe(true);
  });
});
