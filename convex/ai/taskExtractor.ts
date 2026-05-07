"use node";

// ─────────────────────────────────────────────────────────────────────────────
// taskExtractor.ts — port of services/ai/task-extractor.ts.
//
// Two actions:
//   - extractTasks(threadId) — extract & insert open tasks from a thread
//   - checkTaskResolution(threadId, sentEmailBody) — mark tasks resolved by a
//     newly-sent email
//
// The Anthropic call uses tool_choice to force structured output (matches
// the existing Prisma version exactly).
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireUser } from "../lib/auth";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-sonnet-4-6";

interface ExtractedTask {
  description: string;
  taskType: "PROMISE" | "DEADLINE" | "CHANGE_REQUEST" | "ACTION_ITEM";
  contactEmail: string | null;
  contactName: string | null;
  deadline: string | null; // ISO date
  status: "OPEN" | "DONE";
}

// Backing queries/mutations live in convex/ai/taskExtractorData.ts.

// ── Actions ─────────────────────────────────────────────────────────────────

export const extractTasks = action({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);

    const contextText: string = await ctx.runQuery(
      internal.ai.taskExtractorData._buildThreadContextForTasks,
      { threadId },
    );
    if (!contextText) return { created: 0, tasks: [] };

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: `You extract actionable tasks from email threads. Today's date is ${new Date().toISOString().split("T")[0]}.

Identify:
- PROMISE: Things the sender/user promised to do ("I'll send you...", "We'll have it by...")
- DEADLINE: Things with explicit deadlines ("by Friday", "before March 15")
- CHANGE_REQUEST: Requests for changes or updates ("Can you update...", "Please revise...")
- ACTION_ITEM: General action items that need doing

For deadlines, convert relative dates to absolute ISO dates based on the email dates.
Mark tasks as DONE if a later email in the thread clearly fulfills them.
Only extract real, actionable tasks — not general discussion points.`,
      tools: [
        {
          name: "extract_tasks",
          description: "Extract tasks found in the email thread",
          input_schema: {
            type: "object" as const,
            properties: {
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: {
                      type: "string",
                      description: "Clear, concise task description",
                    },
                    taskType: {
                      type: "string",
                      enum: [
                        "PROMISE",
                        "DEADLINE",
                        "CHANGE_REQUEST",
                        "ACTION_ITEM",
                      ],
                    },
                    contactEmail: {
                      type: "string",
                      description:
                        "Email of the person who assigned/requested this, or null",
                    },
                    contactName: {
                      type: "string",
                      description: "Name of the contact, or null",
                    },
                    deadline: {
                      type: "string",
                      description:
                        "ISO date string if there is a deadline, or null",
                    },
                    status: {
                      type: "string",
                      enum: ["OPEN", "DONE"],
                      description: "DONE if fulfilled by later emails",
                    },
                  },
                  required: ["description", "taskType", "status"],
                },
              },
            },
            required: ["tasks"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "extract_tasks" },
      messages: [{ role: "user", content: contextText }],
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      return { created: 0, tasks: [] };
    }

    const { tasks: extracted } = toolBlock.input as { tasks: ExtractedTask[] };

    const existingDescs: string[] = await ctx.runQuery(
      internal.ai.taskExtractorData._getExistingTaskDescriptions,
      { threadId, userId },
    );
    const existingSet = new Set(existingDescs);
    const toCreate = extracted.filter(
      (t) => !existingSet.has(t.description.toLowerCase()),
    );
    if (toCreate.length === 0) return { created: 0, tasks: [] };

    const ids = (await ctx.runMutation(
      internal.ai.taskExtractorData._insertTasks,
      {
        threadId,
        userId,
        tasks: toCreate.map((t) => ({
          description: t.description,
          taskType: t.taskType,
          contactEmail: t.contactEmail || undefined,
          contactName: t.contactName || undefined,
          deadline: t.deadline ? new Date(t.deadline).getTime() : undefined,
          status:
            t.status === "DONE"
              ? ("DONE" as const)
              : ("OPEN" as const),
        })),
      },
    )) as Id<"tasks">[];

    return { created: ids.length, tasks: ids };
  },
});

export const checkTaskResolution = internalAction({
  args: {
    threadId: v.id("threads"),
    userId: v.id("users"),
    sentEmailBody: v.string(),
  },
  handler: async (ctx, { threadId, userId, sentEmailBody }) => {
    const openTasks: Array<{ id: Id<"tasks">; description: string }> =
      await ctx.runQuery(internal.ai.taskExtractorData._getOpenTasks, {
        threadId,
        userId,
      });
    if (openTasks.length === 0) return [];

    const taskList = openTasks
      .map((t, i) => `${i + 1}. [ID: ${t.id}] ${t.description}`)
      .join("\n");

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        "You determine which tasks are fulfilled by a sent email. Return only the IDs of resolved tasks.",
      tools: [
        {
          name: "resolve_tasks",
          description: "Mark tasks as resolved",
          input_schema: {
            type: "object" as const,
            properties: {
              resolvedTaskIds: {
                type: "array",
                items: { type: "string" },
                description: "IDs of tasks that are fulfilled by this email",
              },
            },
            required: ["resolvedTaskIds"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "resolve_tasks" },
      messages: [
        {
          role: "user",
          content: `Open tasks:\n${taskList}\n\nEmail just sent:\n${sentEmailBody}`,
        },
      ],
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") return [];

    const { resolvedTaskIds } = toolBlock.input as {
      resolvedTaskIds: string[];
    };
    if (resolvedTaskIds.length > 0) {
      await ctx.runMutation(internal.ai.taskExtractorData._autoResolveTasks, {
        taskIds: resolvedTaskIds as Id<"tasks">[],
        userId,
      });
    }
    return resolvedTaskIds;
  },
});
