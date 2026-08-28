import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `getOptionalUser()` regression guard for the "public pages must never
 * redirect, and must never show a signed-in visitor as signed out" fix
 * (`app/(public)/layout.tsx`). Stubs `createSupabaseServerClient` the same
 * way `tests/rank/rank.test.ts` stubs its collaborators with `vi.mock`, so
 * this never touches a real Supabase project.
 */
const { getUser, redirect } = vi.hoisted(() => ({
  getUser: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("../../src/auth/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}));

vi.mock("next/navigation", () => ({ redirect }));

import { getOptionalUser } from "../../src/auth/require";

beforeEach(() => {
  getUser.mockReset();
  redirect.mockReset();
});

describe("getOptionalUser", () => {
  it("resolves to a SessionUser when a session with a verified email exists", async () => {
    getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "friend@example.com" } },
    });

    await expect(getOptionalUser()).resolves.toEqual({
      id: "user-1",
      email: "friend@example.com",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("resolves to null when there is no session, without redirecting", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    await expect(getOptionalUser()).resolves.toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("resolves to null when the session's user has no verified email, without redirecting", async () => {
    getUser.mockResolvedValue({
      data: { user: { id: "user-2", email: null } },
    });

    await expect(getOptionalUser()).resolves.toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });
});
