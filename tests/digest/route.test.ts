import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The route's job is auth + validation + "don't send on an empty day"; the
 * actual Resend call is mocked so these run offline and never spend a send.
 */
const sendDigestEmail = vi.hoisted(() =>
  vi.fn<(args: { to: string; subject: string; html: string; text: string }) => Promise<{ id: string }>>(
    async () => ({ id: "email_123" }),
  ),
);

vi.mock("@/src/digest/send", async () => {
  const actual = await vi.importActual<typeof import("@/src/digest/send")>("@/src/digest/send");
  return { ...actual, sendDigestEmail };
});

const { POST } = await import("@/app/api/public/digest/route");

const SECRET = "test-secret-value";

function request(body: unknown, token: string | null = SECRET) {
  return new Request("https://applyops.test/api/public/digest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const goodJob = {
  company: "Neo Financial",
  title: "Junior Software Engineer",
  url: "https://neofinancial.com/careers/123",
  summary: "Backend services in TypeScript.",
  score: 80,
};

beforeEach(() => {
  sendDigestEmail.mockClear();
  process.env.DIGEST_SECRET = SECRET;
  process.env.OWNER_EMAIL = "owner@example.test";
});

afterEach(() => {
  delete process.env.DIGEST_SECRET;
  delete process.env.OWNER_EMAIL;
});

describe("POST /api/digest", () => {
  it("rejects a missing token", async () => {
    const res = await POST(request({ checked: 1, jobs: [goodJob] }, null));
    expect(res.status).toBe(401);
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("rejects a wrong token", async () => {
    const res = await POST(request({ checked: 1, jobs: [goodJob] }, "nope"));
    expect(res.status).toBe(401);
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("rejects a token that is a prefix of the real one", async () => {
    const res = await POST(request({ checked: 1, jobs: [goodJob] }, SECRET.slice(0, -1)));
    expect(res.status).toBe(401);
  });

  it("503s when the endpoint has no secret configured", async () => {
    delete process.env.DIGEST_SECRET;
    const res = await POST(request({ checked: 1, jobs: [goodJob] }));
    expect(res.status).toBe(503);
  });

  it("rejects a malformed payload", async () => {
    const res = await POST(request({ checked: 1, jobs: [{ company: "x" }] }));
    expect(res.status).toBe(400);
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("sends nothing on an empty day and still reports success", async () => {
    const res = await POST(request({ checked: 35, jobs: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: false, checked: 35 });
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("sends to OWNER_EMAIL only — the payload cannot choose a recipient", async () => {
    const res = await POST(
      request({ checked: 35, jobs: [goodJob], to: "attacker@evil.test" }),
    );
    expect(res.status).toBe(200);
    expect(sendDigestEmail).toHaveBeenCalledOnce();
    expect(sendDigestEmail.mock.calls[0][0]).toMatchObject({ to: "owner@example.test" });
  });
});
