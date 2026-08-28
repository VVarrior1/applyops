import { describe, expect, it } from "vitest";
import {
  checkContact,
  contactIsUsable,
  contactProblemSummary,
  type ProfileContact,
} from "@/src/profile/contact";

/** The exact row QA found on the owner's live profile. */
const QA_PLACEHOLDER: ProfileContact = {
  name: "ApplyOps Test Resume",
  email: "candidate@example.com",
  phone: "555-0100",
  links: ["github.com/example-candidate"],
};

const REAL: ProfileContact = {
  name: "Dana Okonkwo",
  email: "dana.okonkwo@protonmail.com",
  phone: "(587) 891-6940",
  links: ["https://github.com/dokonkwo", "https://linkedin.com/in/dokonkwo"],
};

function fields(contact: ProfileContact): string[] {
  return checkContact(contact).map((problem) => `${problem.field}:${problem.kind}`);
}

describe("checkContact", () => {
  it("flags every field of the placeholder row QA found", () => {
    expect(fields(QA_PLACEHOLDER)).toEqual([
      "name:placeholder",
      "email:placeholder",
      "phone:placeholder",
      "links:placeholder",
    ]);
    expect(contactIsUsable(QA_PLACEHOLDER)).toBe(false);
  });

  it("passes a real contact block", () => {
    expect(checkContact(REAL)).toEqual([]);
    expect(contactIsUsable(REAL)).toBe(true);
  });

  it("treats an empty or absent contact as missing name and email", () => {
    expect(fields({})).toEqual(["name:missing", "email:missing"]);
    expect(checkContact(null)).toHaveLength(2);
    expect(checkContact(undefined)).toHaveLength(2);
  });

  it("does not require a phone or links", () => {
    expect(checkContact({ name: "Dana Okonkwo", email: "dana@okonkwo.dev" })).toEqual([]);
    expect(
      checkContact({ name: "Dana Okonkwo", email: "dana@okonkwo.dev", phone: "", links: [] }),
    ).toEqual([]);
  });

  it.each([
    "Test User",
    "Sample Candidate",
    "Your Name",
    "John Doe",
    "jane doe",
    "Placeholder",
    "ApplyOps Owner",
  ])("rejects the placeholder name %j", (name) => {
    expect(fields({ ...REAL, name })).toEqual(["name:placeholder"]);
  });

  it.each(["A", "  ", "123"])("rejects the unusable name %j", (name) => {
    const problems = checkContact({ ...REAL, name });
    expect(problems).toHaveLength(1);
    expect(problems[0].field).toBe("name");
  });

  it.each([
    "candidate@example.com",
    "someone@example.org",
    "abdu@test.com",
    "test@gmail.com",
    "you@yourdomain.com",
    "username@sample.com",
  ])("rejects the placeholder email %j", (email) => {
    expect(fields({ ...REAL, email })).toEqual(["email:placeholder"]);
  });

  // `user@localhost` has no dot in the host, so it trips the shape check
  // before the placeholder-domain list ever sees it. Still rejected, which is
  // all the download gate cares about.
  it.each(["not-an-email", "a@b", "two@@at.com", "spaces here@mail.com", "user@localhost"])(
    "rejects the malformed email %j",
    (email) => {
      expect(fields({ ...REAL, email })).toEqual(["email:malformed"]);
    },
  );

  it("does not mistake a real domain that merely starts with 'example'", () => {
    expect(checkContact({ ...REAL, email: "dana@examplebank.com" })).toEqual([]);
  });

  it.each(["555-0100", "(403) 555-0142", "+1 587 555-0199", "000-000-0000", "123-456-7890"])(
    "rejects the placeholder phone %j",
    (phone) => {
      expect(fields({ ...REAL, phone })).toEqual(["phone:placeholder"]);
    },
  );

  it.each(["(587) 891-6940", "403-555-2210", "+1 (416) 555-9812", "456-7890"])(
    "accepts the real-shaped phone %j",
    (phone) => {
      expect(checkContact({ ...REAL, phone })).toEqual([]);
    },
  );

  it("rejects a phone with too few digits", () => {
    expect(fields({ ...REAL, phone: "12345" })).toEqual(["phone:malformed"]);
  });

  it("reports one problem per placeholder link and ignores real ones", () => {
    const problems = checkContact({
      ...REAL,
      links: [
        "https://github.com/dokonkwo",
        "github.com/example-candidate",
        "https://github.com/yourusername",
      ],
    });
    expect(problems.map((p) => p.field)).toEqual(["links", "links"]);
  });
});

describe("contactProblemSummary", () => {
  it("is empty when there is nothing to say", () => {
    expect(contactProblemSummary([])).toBe("");
  });

  it("names the offending values and points at Settings", () => {
    const summary = contactProblemSummary(checkContact(QA_PLACEHOLDER));
    expect(summary).toContain("ApplyOps Test Resume");
    expect(summary).toContain("candidate@example.com");
    expect(summary).toContain("Settings");
  });
});
