import { describe, it, expect } from "vitest";
import { renderSms } from "@/src/alerts/sms";

describe("renderSms", () => {
  const job = {
    company: "Jobber",
    title: "Software Engineer I",
    location: "Edmonton, AB",
    score: 88,
    url: "https://jobs.ashbyhq.com/jobber/abc",
  };

  it("leads with the role and carries the link", () => {
    const body = renderSms(job);
    expect(body).toContain("Software Engineer I — Jobber");
    expect(body).toContain("Edmonton, AB");
    expect(body).toContain("fit 88/100");
    expect(body).toContain(job.url);
  });

  it("stays inside one lock-screen glance", () => {
    expect(renderSms(job).length).toBeLessThan(200);
  });

  it("omits the location cleanly when there is none", () => {
    expect(renderSms({ ...job, location: "" })).not.toContain(" · fit");
  });

  it("truncates a pathological payload rather than letting Twilio reject it", () => {
    expect(renderSms({ ...job, company: "x".repeat(5000) }).length).toBeLessThanOrEqual(1500);
  });
});
