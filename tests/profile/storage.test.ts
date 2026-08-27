import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteAllResumeObjects, RESUME_BUCKET, RESUME_LIST_PAGE_SIZE } from "../../src/profile/storage";

// ---------------------------------------------------------------------------
// A minimal fake Supabase Storage client — just enough of
// `client.storage.from(bucket).list()/.remove()` to drive
// deleteAllResumeObjects's pagination and error-propagation logic with no
// network call and no live credentials.
// ---------------------------------------------------------------------------

function fakeStorageClient(opts: {
  /** One array of `{name}` objects per `list()` call, in call order. */
  pages?: { name: string }[][];
  /** If set, every `list()` call after `errorOnCall`-th (1-indexed) errors. */
  listError?: { message: string };
  listErrorOnCall?: number;
  removeError?: { message: string };
}) {
  const listCalls: Array<{ prefix?: string; limit?: number; offset?: number }> = [];
  const removeCalls: string[][] = [];
  let listCallCount = 0;

  const client = {
    storage: {
      from(bucket: string) {
        expect(bucket).toBe(RESUME_BUCKET);
        return {
          async list(prefix: string, options?: { limit?: number; offset?: number }) {
            listCallCount += 1;
            listCalls.push({ prefix, ...options });
            if (opts.listError && (!opts.listErrorOnCall || listCallCount === opts.listErrorOnCall)) {
              return { data: null, error: opts.listError };
            }
            const page = (opts.pages ?? [])[listCallCount - 1] ?? [];
            return { data: page, error: null };
          },
          async remove(paths: string[]) {
            removeCalls.push(paths);
            if (opts.removeError) return { data: null, error: opts.removeError };
            return { data: paths.map((p) => ({ name: p })), error: null };
          },
        };
      },
    },
  };

  return { client: client as unknown as SupabaseClient, listCalls, removeCalls };
}

describe("deleteAllResumeObjects", () => {
  it("does nothing (and never calls remove) when the user has no objects", async () => {
    const { client, listCalls, removeCalls } = fakeStorageClient({ pages: [[]] });

    await deleteAllResumeObjects("user-1", client);

    expect(listCalls).toEqual([{ prefix: "user-1", limit: RESUME_LIST_PAGE_SIZE, offset: 0 }]);
    expect(removeCalls).toEqual([]);
  });

  it("removes a single short page in one round trip", async () => {
    const { client, listCalls, removeCalls } = fakeStorageClient({
      pages: [[{ name: "1700000000000.pdf" }, { name: "1700000000001.pdf" }]],
    });

    await deleteAllResumeObjects("user-1", client);

    expect(listCalls).toHaveLength(1);
    expect(removeCalls).toEqual([["user-1/1700000000000.pdf", "user-1/1700000000001.pdf"]]);
  });

  it("paginates with limit/offset until a short page ends the loop", async () => {
    const fullPage = Array.from({ length: RESUME_LIST_PAGE_SIZE }, (_, i) => ({ name: `${i}.pdf` }));
    const shortPage = [{ name: "last.pdf" }];
    const { client, listCalls, removeCalls } = fakeStorageClient({ pages: [fullPage, shortPage] });

    await deleteAllResumeObjects("user-1", client);

    expect(listCalls).toEqual([
      { prefix: "user-1", limit: RESUME_LIST_PAGE_SIZE, offset: 0 },
      { prefix: "user-1", limit: RESUME_LIST_PAGE_SIZE, offset: RESUME_LIST_PAGE_SIZE },
    ]);
    expect(removeCalls).toHaveLength(2);
    expect(removeCalls[0]).toHaveLength(RESUME_LIST_PAGE_SIZE);
    expect(removeCalls[1]).toEqual(["user-1/last.pdf"]);
  });

  it("propagates a real list() failure instead of treating it as 'nothing to delete'", async () => {
    const { client, removeCalls } = fakeStorageClient({
      listError: { message: "Invalid Compact JWS" },
    });

    await expect(deleteAllResumeObjects("user-1", client)).rejects.toMatchObject({
      message: "Invalid Compact JWS",
    });
    expect(removeCalls).toEqual([]);
  });

  it("propagates a real remove() failure", async () => {
    const { client } = fakeStorageClient({
      pages: [[{ name: "a.pdf" }]],
      removeError: { message: "network error" },
    });

    await expect(deleteAllResumeObjects("user-1", client)).rejects.toMatchObject({
      message: "network error",
    });
  });
});
