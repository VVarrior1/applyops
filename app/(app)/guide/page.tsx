import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { GuideWorkspace } from "@/components/guide/GuideWorkspace";
import { getLatestGuide, loadConversation } from "@/src/guide/store";
import { getConfirmedFacts } from "@/src/profile/facts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Guide",
};

/**
 * `/guide` — the personalized outlook and a chat that is grounded in the same
 * data.
 *
 * Everything the page renders is loaded server-side and handed to one client
 * component: the cached guide (newest row in `guides`), the existing
 * conversation, and whether the user has any confirmed facts at all — which is
 * what decides whether generating a guide is even meaningful.
 */
export default async function GuidePage() {
  const user = await requireUser();
  const db = getDb();

  const [guide, conversation, facts] = await Promise.all([
    getLatestGuide(db, user.id),
    loadConversation(db, user.id),
    getConfirmedFacts(db, user.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Guide</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          An honest read on where your search stands, and someone to argue with
          about it. Both are written from your confirmed facts — nothing here is
          invented.
        </p>
      </div>

      <GuideWorkspace
        initialGuide={guide?.output ?? null}
        initialGeneratedAt={guide?.createdAt.toISOString() ?? null}
        initialModelId={guide?.modelId ?? null}
        canGenerate={facts.length > 0}
        chatModelId={conversation.thread?.modelId ?? null}
        chatMessages={conversation.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          modelId: message.modelId,
          costUsd: message.costUsd,
        }))}
      />
    </div>
  );
}
