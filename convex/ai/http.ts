"use node";

// ─────────────────────────────────────────────────────────────────────────────
// http.ts — Server-Sent Events streaming endpoint for AI chat.
//
// Mirrors the Fastify route at packages/backend/src/routes/ai/index.ts
// `POST /api/ai/chat/stream`. Body:
//   {
//     message: string,
//     messages?: { role: "user"|"assistant", content: string }[],
//     threadId?: string,
//     accountId?: string,
//     scope?: "thread" | "all",
//     composeContext?: { to, subject, body, mode, threadId? },
//     conversationId?: Id<"chatConversations">  // optional, for persistence
//   }
//
// Auth: enforced via ctx.auth.getUserIdentity() — Convex Auth populates this
// from the session cookie / Authorization header on the incoming request.
//
// Streaming: returns a `text/event-stream` response. Each SSE `data:` frame
// matches the existing client expectations:
//   {"type": "text_delta", "data": {"text": "..."}}
//   {"type": "tool_result", "data": {...}}
//   {"type": "search_results" | "priority_inbox" | "tasks" |
//           "contact_results" | "thread_references", "data": {...}}
//   {"type": "done"}
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { HttpRouter } from "convex/server";
import type { Id } from "../_generated/dataModel";
import {
  TOOLS,
  DATA_TOOL_NAMES,
  OUTPUT_TOOL_NAMES,
} from "./chat";

const MODEL = "claude-sonnet-4-6";
// 3 rounds is required because the system prompt instructs the model to
// chain `search_emails -> get_thread_detail -> answer`. Two rounds drops the
// final answer.
const MAX_TOOL_ROUNDS = 3;
const CHAT_MAX_TOKENS = 1536;
// Shared budget key with the non-streaming chat path.
const CHAT_FEATURE_KEY = "chat";
const DAILY_CHAT_COST_LIMIT_USD = 5;

async function recordAiUsage(
  ctx: { runMutation: (...args: unknown[]) => Promise<unknown> },
  args: {
    userId: Id<"users">;
    feature: string;
    inputTokens?: number;
    outputTokens?: number;
    providerCallCount?: number;
    requestId?: string;
    metadata?: unknown;
  },
) {
  try {
    await ctx.runMutation(internal.ai.usageData._record, {
      userId: args.userId,
      feature: args.feature,
      model: MODEL,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      providerCallCount: args.providerCallCount ?? 1,
      requestId: args.requestId,
      metadata: args.metadata,
    });
  } catch {
    // Usage logging must not interrupt streaming.
  }
}

interface StreamBody {
  message: string;
  messages?: { role: "user" | "assistant"; content: string }[];
  threadId?: string;
  accountId?: string;
  scope?: "thread" | "all";
  composeContext?: {
    to: string;
    subject: string;
    body: string;
    mode: string;
    threadId?: string;
  };
  conversationId?: string;
}

const streamChat = httpAction(async (ctx, req) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: StreamBody;
  try {
    body = (await req.json()) as StreamBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.message?.trim()) {
    return new Response(JSON.stringify({ error: "Message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Optional conversation persistence — verify ownership if provided.
  let conversationId: Id<"chatConversations"> | undefined;
  if (body.conversationId) {
    const ok: boolean = await ctx.runQuery(
      internal.ai.chatHistory.assertConversationOwner,
      {
        conversationId: body.conversationId as Id<"chatConversations">,
        userId,
      },
    );
    if (ok) conversationId = body.conversationId as Id<"chatConversations">;
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const send = async (event: { type: string; data?: unknown }) => {
    await writer.write(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  // Run the streaming logic in the background so we can return the readable
  // side immediately. Errors are surfaced as a final SSE frame.
  void (async () => {
    try {
      const ctxResult: {
        systemPrompt: string;
        primaryRecipient: string | null;
        correctionsApplied: number;
      } = await ctx.runQuery(internal.ai.chatData.buildContext, {
        threadId: body.threadId as Id<"threads"> | undefined,
        accountId: body.accountId as Id<"mailAccounts"> | undefined,
        userId,
        scope: body.scope,
        composeContext: body.composeContext,
      });

      const dailyUsage = (await ctx.runQuery(internal.ai.usageData._dailyUsage, {
        userId,
        feature: CHAT_FEATURE_KEY,
      })) as { estimatedCostUsd: number };
      if (dailyUsage.estimatedCostUsd >= DAILY_CHAT_COST_LIMIT_USD) {
        // Surface as an explicit error frame so the UI can render a banner
        // instead of treating it like a normal assistant reply.
        await send({
          type: "error",
          data: {
            code: "daily_budget_exceeded",
            message: "You've hit today's AI chat budget. Try again tomorrow.",
          },
        });
        await send({ type: "done" });
        return;
      }

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const userMessages = [
        ...(body.messages || []),
        { role: "user" as const, content: body.message.trim() },
      ];
      let messages: Anthropic.MessageParam[] = userMessages
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

      let assistantContent = "";

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const isLastRound = round === MAX_TOOL_ROUNDS - 1;
        const stream = client.messages.stream({
          model: MODEL,
          max_tokens: CHAT_MAX_TOKENS,
          system: ctxResult.systemPrompt,
          messages,
          tools: TOOLS,
        });

        const toolUses: Array<{
          id: string;
          name: string;
          inputJson: string;
        }> = [];
        let currentToolName = "";
        let currentToolId = "";
        let toolInputJson = "";

        for await (const event of stream) {
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          ) {
            currentToolName = event.content_block.name;
            currentToolId = event.content_block.id;
            toolInputJson = "";
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              await send({
                type: "text_delta",
                data: { text: event.delta.text },
              });
              assistantContent += event.delta.text;
            } else if (event.delta.type === "input_json_delta") {
              toolInputJson += event.delta.partial_json;
            }
          } else if (event.type === "content_block_stop" && currentToolName) {
            toolUses.push({
              id: currentToolId,
              name: currentToolName,
              inputJson: toolInputJson,
            });
            currentToolName = "";
            currentToolId = "";
            toolInputJson = "";
          }
        }

        const finalMessage = await stream.finalMessage();
        await recordAiUsage(
          ctx as unknown as { runMutation: (...args: unknown[]) => Promise<unknown> },
          {
            userId,
            feature: CHAT_FEATURE_KEY,
            inputTokens: finalMessage.usage?.input_tokens,
            outputTokens: finalMessage.usage?.output_tokens,
            providerCallCount: 1,
            metadata: {
              round,
              transport: "stream",
              stopReason: finalMessage.stop_reason,
              truncated: finalMessage.stop_reason === "max_tokens",
            },
          },
        );

        if (toolUses.length === 0) {
          break;
        }

        const outputTools = toolUses.filter((t) => OUTPUT_TOOL_NAMES.has(t.name));
        const dataTools = toolUses.filter((t) => DATA_TOOL_NAMES.has(t.name));

        if (outputTools.length > 0) {
          for (const tool of outputTools) {
            try {
              const input = JSON.parse(tool.inputJson) as Record<
                string,
                unknown
              >;
              if (tool.name === "generate_draft") {
                await send({
                  type: "tool_result",
                  data: {
                    tool: "generate_draft",
                    draft: {
                      to:
                        (input.to as string) ||
                        ctxResult.primaryRecipient ||
                        undefined,
                      subject: input.subject,
                      body: input.body,
                      threadId: body.threadId,
                      greetingUsed: input.greeting_used,
                      signoffUsed: input.signoff_used,
                      correctionsApplied: ctxResult.correctionsApplied,
                    },
                  },
                });
              } else if (tool.name === "summarize_thread") {
                const summary = input.summary as string;
                const keyPoints = (input.key_points as string[]) || [];
                const actionItems = (input.action_items as string[]) || [];
                let text = `**Summary**\n${summary}\n\n**Key Points**\n${keyPoints.map((p) => `• ${p}`).join("\n")}`;
                if (actionItems.length > 0) {
                  text += `\n\n**Action Items**\n${actionItems.map((a) => `• ${a}`).join("\n")}`;
                }
                await send({
                  type: "tool_result",
                  data: { tool: "summarize_thread", text },
                });
              } else if (tool.name === "extract_action_items") {
                const items =
                  (input.items as Array<{
                    description: string;
                    assignee?: string;
                    deadline?: string;
                    status: string;
                  }>) || [];
                const statusLabel: Record<string, string> = {
                  done: "[done]",
                  in_progress: "[in progress]",
                  pending: "[pending]",
                };
                const text = `**Action Items**\n${items
                  .map((it) => {
                    let line = `${statusLabel[it.status] || "[?]"} ${it.description}`;
                    if (it.assignee) line += ` — ${it.assignee}`;
                    if (it.deadline) line += ` (due: ${it.deadline})`;
                    return line;
                  })
                  .join("\n")}`;
                await send({
                  type: "tool_result",
                  data: { tool: "extract_action_items", text },
                });
              }
            } catch {
              // skip malformed tool input
            }
          }
          break;
        }

        if (dataTools.length > 0) {
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tool of dataTools) {
            try {
              const input = JSON.parse(tool.inputJson) as Record<
                string,
                unknown
              >;
              const result: {
                toolUseId: string;
                content: string;
                sideEffects?: {
                  searchResults?: unknown[];
                  priorityInbox?: unknown[];
                  tasks?: unknown[];
                  contactResults?: unknown[];
                  threadReferences?: { id: string; subject: string }[];
                };
              } = await ctx.runAction(internal.ai.chat.runTool, {
                userId,
                toolUseId: tool.id,
                toolName: tool.name,
                toolInput: input,
              });

              if (result.sideEffects?.searchResults) {
                await send({
                  type: "search_results",
                  data: { results: result.sideEffects.searchResults },
                });
              }
              if (result.sideEffects?.priorityInbox) {
                await send({
                  type: "priority_inbox",
                  data: { emails: result.sideEffects.priorityInbox },
                });
              }
              if (result.sideEffects?.tasks) {
                await send({
                  type: "tasks",
                  data: { tasks: result.sideEffects.tasks },
                });
              }
              if (result.sideEffects?.contactResults) {
                await send({
                  type: "contact_results",
                  data: { contacts: result.sideEffects.contactResults },
                });
              }
              if (result.sideEffects?.threadReferences) {
                await send({
                  type: "thread_references",
                  data: { references: result.sideEffects.threadReferences },
                });
              }

              toolResults.push({
                type: "tool_result",
                tool_use_id: result.toolUseId,
                content: result.content,
              });
            } catch {
              toolResults.push({
                type: "tool_result",
                tool_use_id: tool.id,
                content: JSON.stringify({ error: "Tool execution failed" }),
              });
            }
          }

          messages = [
            ...messages,
            { role: "assistant", content: finalMessage.content },
            { role: "user", content: toolResults },
          ];

          if (isLastRound) {
            const finalStream = client.messages.stream({
              model: MODEL,
              max_tokens: CHAT_MAX_TOKENS,
              system: ctxResult.systemPrompt,
              messages,
              tools: TOOLS,
            });
            for await (const event of finalStream) {
              if (
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta"
              ) {
                await send({
                  type: "text_delta",
                  data: { text: event.delta.text },
                });
                assistantContent += event.delta.text;
              }
            }
            const finalStreamMessage = await finalStream.finalMessage();
            await recordAiUsage(
              ctx as unknown as { runMutation: (...args: unknown[]) => Promise<unknown> },
              {
                userId,
                feature: CHAT_FEATURE_KEY,
                inputTokens: finalStreamMessage.usage?.input_tokens,
                outputTokens: finalStreamMessage.usage?.output_tokens,
                providerCallCount: 1,
                metadata: {
                  round,
                  final: true,
                  transport: "stream",
                  stopReason: finalStreamMessage.stop_reason,
                  truncated: finalStreamMessage.stop_reason === "max_tokens",
                },
              },
            );
            break;
          }
        }
      }

      // Persist final assistant message if a conversation was provided.
      if (conversationId && assistantContent) {
        await ctx.runMutation(internal.ai.chatData.saveAssistantMessage, {
          conversationId,
          content: assistantContent,
        });
      }

      await send({ type: "done" });
    } catch (err) {
      await send({
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

export function addAiHttpRoutes(http: HttpRouter) {
  http.route({ path: "/ai/chat/stream", method: "POST", handler: streamChat });
}
