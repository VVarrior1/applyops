"use client";

import { useMemo, useState } from "react";
import { buildSuggestedQuestions } from "@/src/guide/questions";
import type { GuideOutput } from "@/src/pipeline/schemas";
import { GuideChat, type InitialChatMessage } from "./GuideChat";
import { GuideView } from "./GuideView";

export interface GuideWorkspaceProps {
  initialGuide: GuideOutput | null;
  initialGeneratedAt: string | null;
  initialModelId: string | null;
  canGenerate: boolean;
  chatMessages: InitialChatMessage[];
  chatModelId: string | null;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/**
 * The two halves of `/guide`, and the one piece of state they share.
 *
 * The guide lives here rather than inside `GuideView` because the chat's
 * suggested questions are derived from it: regenerating the outlook has to
 * change the chips on the right at the same moment it changes the cards on the
 * left, or the page is quietly telling the user two different things.
 */
export function GuideWorkspace({
  initialGuide,
  initialGeneratedAt,
  initialModelId,
  canGenerate,
  chatMessages,
  chatModelId,
}: GuideWorkspaceProps) {
  const [guide, setGuide] = useState<GuideOutput | null>(initialGuide);
  const [generatedAt, setGeneratedAt] = useState<string | null>(initialGeneratedAt);
  const [modelId, setModelId] = useState<string | null>(initialModelId);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestedQuestions = useMemo(
    () => buildSuggestedQuestions(guide),
    [guide],
  );

  async function handleRegenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/guide", { method: "POST" });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      const body = (await res.json()) as {
        guide: { output: GuideOutput; modelId: string; createdAt: string };
      };
      setGuide(body.guide.output);
      setGeneratedAt(body.guide.createdAt);
      setModelId(body.guide.modelId);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
      <GuideView
        guide={guide}
        generatedAt={generatedAt}
        modelId={modelId}
        canGenerate={canGenerate}
        generating={generating}
        error={error}
        onRegenerate={() => void handleRegenerate()}
      />
      {/*
       * The height cap applies at every breakpoint, not just `lg:` — below
       * `lg` this stacks under GuideView in normal flow, but without a cap
       * the message list (which only scrolls internally, see GuideChat) can
       * still grow to fill an unbounded column and push the composer far off
       * the bottom of a tall page. `dvh` (not `vh`) so mobile browser chrome
       * that shows/hides on scroll is accounted for.
       */}
      <div className="h-[calc(100dvh-3rem)] lg:sticky lg:top-6">
        <GuideChat
          initialMessages={chatMessages}
          initialModelId={chatModelId}
          suggestedQuestions={suggestedQuestions}
        />
      </div>
    </div>
  );
}
