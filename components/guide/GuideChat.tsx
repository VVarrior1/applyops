"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ModelOption } from "@/src/guide/models";
import { ChatMarkdown } from "./ChatMarkdown";

/** Mirrors `ChatMessageMetadata` in `app/api/guide/chat/route.ts`. */
export interface ChatMetadata {
  modelId?: string;
  costUsd?: number;
}

export type ChatUIMessage = UIMessage<ChatMetadata>;

export interface InitialChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId: string | null;
  costUsd: number | null;
}

export interface GuideChatProps {
  initialMessages: InitialChatMessage[];
  initialModelId: string | null;
  suggestedQuestions: string[];
}

/** Sub-cent costs need four decimals or every reply reads as "$0.00". */
function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function textOf(message: ChatUIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toUIMessage(message: InitialChatMessage): ChatUIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: [{ type: "text", text: message.content }],
    metadata: {
      modelId: message.modelId ?? undefined,
      costUsd: message.costUsd ?? undefined,
    },
  };
}

/**
 * The right half of `/guide`: a chat that already knows who it is talking to.
 *
 * Three things make it more than a chat box — the model picker (only models
 * this deployment has a key for, cheapest first, with the price shown), the
 * suggested questions derived from the user's own guide, and the per-message
 * cost hint that comes back as stream metadata so spending is visible as it
 * happens rather than at the end of the day.
 */
export function GuideChat({
  initialMessages,
  initialModelId,
  suggestedQuestions,
}: GuideChatProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string>(initialModelId ?? "");
  const [input, setInput] = useState("");

  const { messages, sendMessage, status, error, stop } = useChat<ChatUIMessage>({
    messages: initialMessages.map(toUIMessage),
    transport: new DefaultChatTransport<ChatUIMessage>({
      api: "/api/guide/chat",
    }),
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/guide/models");
        if (!res.ok) return;
        const body = (await res.json()) as {
          models: ModelOption[];
          defaultModelId: string | null;
        };
        if (cancelled) return;
        setModels(body.models);
        setModelId((current) => {
          if (current && body.models.some((model) => model.id === current)) {
            return current;
          }
          return body.defaultModelId ?? body.models[0]?.id ?? "";
        });
      } catch {
        // A failed model list is not fatal: the server falls back to the
        // default model when none is sent, so the chat still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const busy = status === "submitted" || status === "streaming";

  // The message list is the chat's only scroller (see GuideWorkspace for the
  // height cap that makes that true); without this, a new reply lands below
  // the fold and the user has to scroll down to see it themselves.
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    // The model goes per-request rather than on the transport: the transport is
    // constructed once, and the user can change the picker between turns.
    void sendMessage(
      { text: question },
      { body: { modelId: modelId || undefined } },
    );
    setInput("");
  }

  const selected = models.find((model) => model.id === modelId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Ask about your search</h2>
          <p className="text-xs text-muted-foreground">
            Grounded in your facts, targets and funnel. It cites{" "}
            <span className="font-mono">F-###</span> labels you can check.
          </p>
        </div>
        {models.length > 0 && (
          <Select
            value={modelId}
            onValueChange={(value) => setModelId(value as string)}
          >
            <SelectTrigger size="sm" aria-label="Model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label} · {model.tier}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {selected && (
        <p className="text-xs text-muted-foreground">
          ${selected.inputPerM.toFixed(2)}/M in · $
          {selected.outputPerM.toFixed(2)}/M out — charged against your daily
          budget.
        </p>
      )}

      <div
        ref={messagesRef}
        // `min-h-0` (not `min-h-64`): GuideWorkspace caps this column's
        // height at every breakpoint now, so this list always has a
        // container to fill and never needs a floor — and a floor here
        // would fight the cap the same way it used to on `lg` (Tailwind
        // emits `.min-h-0` before `.min-h-64` in its generated CSS, so at
        // equal specificity the floor would silently win and reintroduce
        // the overflow this fix removes).
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg border p-3"
      >
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing asked yet. Try one of the questions below.
          </p>
        )}
        {messages.map((message) => {
          const text = textOf(message);
          const cost = message.metadata?.costUsd;
          return (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "flex flex-col items-end gap-1"
                  : "flex flex-col items-start gap-1"
              }
            >
              <div
                className={
                  "max-w-[92%] rounded-lg px-3 py-2 text-sm " +
                  (message.role === "user"
                    ? "whitespace-pre-wrap bg-primary text-primary-foreground"
                    : "bg-muted text-foreground")
                }
              >
                {message.role === "assistant" ? (
                  text ? (
                    <ChatMarkdown text={text} />
                  ) : busy ? (
                    "Thinking…"
                  ) : (
                    ""
                  )
                ) : (
                  text
                )}
              </div>
              {message.role === "assistant" && cost != null && (
                <span className="text-[10px] text-muted-foreground">
                  {formatCost(cost)}
                  {message.metadata?.modelId ? ` · ${message.metadata.modelId}` : ""}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="text-sm text-destructive">
          {error.message || "That didn't go through. Try again."}
        </p>
      )}

      {suggestedQuestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 shrink-0">
          {suggestedQuestions.map((question) => (
            <button
              key={question}
              type="button"
              disabled={busy}
              onClick={() => send(question)}
              className="disabled:opacity-50"
            >
              <Badge
                variant="outline"
                className="cursor-pointer text-left font-normal whitespace-normal"
              >
                {question}
              </Badge>
            </button>
          ))}
        </div>
      )}

      <form
        className="flex items-end gap-2 shrink-0"
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
      >
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(input);
            }
          }}
          rows={2}
          placeholder="Ask anything about your search…"
          className="min-h-16 flex-1"
        />
        {busy ? (
          <Button type="button" variant="outline" onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()}>
            Send
          </Button>
        )}
      </form>
    </div>
  );
}
