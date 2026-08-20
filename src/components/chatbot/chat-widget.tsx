"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };

const GREETING: Message = {
  role: "assistant",
  content:
    "Hi, I can answer questions about Insightful Financial Analytics — what we do, our framework, the industries we focus on, and how we use AI. What would you like to know?",
};

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy) return;

    const nextMessages: Message[] = [...messages, { role: "user", content: question }];
    setMessages(nextMessages);
    setInput("");
    setBusy(true);
    // Placeholder assistant message we stream into.
    setMessages((m) => [...m, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error("bad response");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: acc };
          return copy;
        });
      }
      if (!acc.trim()) {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: "assistant",
            content: "Sorry, I did not catch that. Could you rephrase your question?",
          };
          return copy;
        });
      }
    } catch {
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = {
          role: "assistant",
          content:
            "Sorry, something went wrong reaching the assistant. Please try again, or use the Get Clarity page to contact us.",
        };
        return copy;
      });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <>
      {/* Launcher */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="ifa-chat-panel"
        aria-label={open ? "Close the assistant" : "Ask the IFA assistant"}
        className="bg-background-dark text-text-inverse fixed right-[var(--space-lg)] bottom-[var(--space-lg)] z-[var(--z-modal)] inline-flex h-14 w-14 items-center justify-center rounded-full shadow-medium transition duration-[var(--transition-fast)] ease-[var(--ease-soft)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-focus motion-reduce:transition-none"
      >
        {open ? (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
            <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          id="ifa-chat-panel"
          role="dialog"
          aria-label="Insightful Financial Analytics assistant"
          className="border-border-default bg-background-primary fixed right-[var(--space-lg)] bottom-[calc(var(--space-lg)+4.5rem)] z-[var(--z-modal)] flex h-[32rem] max-h-[calc(100vh-8rem)] w-[calc(100vw-2*var(--space-lg))] max-w-[24rem] flex-col overflow-hidden rounded-md border shadow-medium"
        >
          <header className="border-border-subtle bg-background-secondary flex items-center gap-[var(--space-sm)] border-b px-[var(--space-md)] py-[var(--space-sm)]">
            <span className="bg-background-dark text-signal-focus flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
                <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <div className="flex flex-col">
              <span className="text-body-sm text-text-primary font-medium">IFA Assistant</span>
              <span className="text-meta-sm text-text-secondary">Answers about IFA only</span>
            </div>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-[var(--space-sm)] overflow-y-auto px-[var(--space-md)] py-[var(--space-md)]">
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === "user"
                    ? "bg-background-dark text-text-inverse ml-auto max-w-[85%] rounded-md px-[var(--space-sm)] py-[var(--space-xs)] text-body-sm"
                    : "bg-background-secondary text-text-primary mr-auto max-w-[90%] rounded-md px-[var(--space-sm)] py-[var(--space-xs)] text-body-sm whitespace-pre-wrap"
                }
              >
                {m.content || (busy && i === messages.length - 1 ? "…" : "")}
              </div>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="border-border-subtle flex items-center gap-[var(--space-sm)] border-t px-[var(--space-sm)] py-[var(--space-sm)]">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
              placeholder="Ask about IFA…"
              aria-label="Type your question"
              className="border-border-default bg-background-primary text-text-primary placeholder:text-text-secondary focus:border-border-strong focus:outline-none w-full rounded-md border px-[var(--space-sm)] py-[var(--space-xs)] text-body-sm disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="bg-background-dark text-text-inverse inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition duration-[var(--transition-fast)] ease-[var(--ease-soft)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-focus disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
                <path d="M4 12h15M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>
        </div>
      )}
    </>
  );
}
