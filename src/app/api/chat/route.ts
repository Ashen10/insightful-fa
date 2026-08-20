import { NextResponse } from "next/server";
import {
  assertChatbotConfig,
  buildSystemPrompt,
  retrieve,
  streamChat,
  type ChatMessage,
} from "@/lib/chatbot/azure";

// Run on the Node.js runtime (not Edge): we call Azure over fetch and keep the
// keys server-side only.
export const runtime = "nodejs";
// Never cache chatbot responses.
export const dynamic = "force-dynamic";

type IncomingMessage = { role: "user" | "assistant"; content: string };

const MAX_HISTORY = 6; // keep the last few turns for context
const MAX_INPUT_CHARS = 1500;

export async function POST(req: Request) {
  try {
    assertChatbotConfig();
  } catch {
    return NextResponse.json(
      { error: "The assistant is not available right now." },
      { status: 503 },
    );
  }

  let body: { messages?: IncomingMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const history = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const question = (lastUser?.content ?? "").slice(0, MAX_INPUT_CHARS).trim();

  if (!question) {
    return NextResponse.json({ error: "Empty message." }, { status: 400 });
  }

  // 1. Retrieve grounding context from the website knowledge base.
  let context = "";
  try {
    const hits = await retrieve(question, 5);
    context = hits
      .map((h, i) => `[${i + 1}] (${h.title})\n${h.content}`)
      .join("\n\n---\n\n");
  } catch {
    return NextResponse.json(
      { error: "The assistant could not reach its knowledge base." },
      { status: 502 },
    );
  }

  if (!context) {
    // No indexed content matched — refuse gracefully without calling the model.
    const msg =
      "I can only help with questions about Insightful Financial Analytics and its services. For anything else, please use the Get Clarity page to contact the team.";
    return new Response(msg, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // 2. Assemble the grounded prompt: system + recent turns + current question.
  const recent = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_INPUT_CHARS) }));

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(context) },
    ...recent,
  ];

  // 3. Stream the answer straight from Azure, forwarding only the text deltas.
  let upstream: Response;
  try {
    upstream = await streamChat(messages);
  } catch {
    return NextResponse.json({ error: "The assistant is busy. Please try again." }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "The assistant is busy. Please try again." }, { status: 502 });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") {
              controller.close();
              return;
            }
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(encoder.encode(delta));
            } catch {
              /* ignore keep-alive / partial frames */
            }
          }
        }
      } catch {
        /* upstream ended */
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
