import type { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { buildThreadContext } from './thread-context.js';

const anthropic = new Anthropic();

interface ExtractedTask {
  description: string;
  taskType: 'PROMISE' | 'DEADLINE' | 'CHANGE_REQUEST' | 'ACTION_ITEM';
  contactEmail: string | null;
  contactName: string | null;
  deadline: string | null; // ISO date string
  status: 'OPEN' | 'DONE';
}

/**
 * Extract tasks from a thread using AI.
 */
export async function extractTasks(prisma: PrismaClient, threadId: string, userId: string) {
  const { contextText } = await buildThreadContext(prisma, threadId);
  if (!contextText) return { created: 0, tasks: [] };

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `You extract actionable tasks from email threads. Today's date is ${new Date().toISOString().split('T')[0]}.

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
        name: 'extract_tasks',
        description: 'Extract tasks found in the email thread',
        input_schema: {
          type: 'object' as const,
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string', description: 'Clear, concise task description' },
                  taskType: { type: 'string', enum: ['PROMISE', 'DEADLINE', 'CHANGE_REQUEST', 'ACTION_ITEM'] },
                  contactEmail: { type: 'string', description: 'Email of the person who assigned/requested this, or null' },
                  contactName: { type: 'string', description: 'Name of the contact, or null' },
                  deadline: { type: 'string', description: 'ISO date string if there is a deadline, or null' },
                  status: { type: 'string', enum: ['OPEN', 'DONE'], description: 'DONE if fulfilled by later emails' },
                },
                required: ['description', 'taskType', 'status'],
              },
            },
          },
          required: ['tasks'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_tasks' },
    messages: [
      { role: 'user', content: contextText },
    ],
  });

  // Parse tool result
  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') return { created: 0, tasks: [] };

  const { tasks: extracted } = toolBlock.input as { tasks: ExtractedTask[] };

  // Deduplicate: check for existing tasks on this thread
  const existing = await prisma.task.findMany({
    where: { threadId, userId },
    select: { description: true },
  });
  const existingDescs = new Set(existing.map((t) => t.description.toLowerCase()));

  const toCreate = extracted.filter(
    (t) => !existingDescs.has(t.description.toLowerCase()),
  );

  if (toCreate.length === 0) return { created: 0, tasks: [] };

  const created = await Promise.all(
    toCreate.map((t) =>
      prisma.task.create({
        data: {
          userId,
          threadId,
          description: t.description,
          taskType: t.taskType,
          contactEmail: t.contactEmail || null,
          contactName: t.contactName || null,
          deadline: t.deadline ? new Date(t.deadline) : null,
          status: t.status === 'DONE' ? 'DONE' : 'OPEN',
          resolvedAt: t.status === 'DONE' ? new Date() : null,
          resolvedBy: t.status === 'DONE' ? 'auto' : null,
        },
      }),
    ),
  );

  return { created: created.length, tasks: created };
}

/**
 * Check if a sent email resolves any open tasks in the thread.
 */
export async function checkTaskResolution(
  prisma: PrismaClient,
  threadId: string,
  userId: string,
  sentEmailBody: string,
) {
  const openTasks = await prisma.task.findMany({
    where: { threadId, userId, status: 'OPEN' },
  });

  if (openTasks.length === 0) return [];

  const taskList = openTasks
    .map((t, i) => `${i + 1}. [ID: ${t.id}] ${t.description}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You determine which tasks are fulfilled by a sent email. Return only the IDs of resolved tasks.',
    tools: [
      {
        name: 'resolve_tasks',
        description: 'Mark tasks as resolved',
        input_schema: {
          type: 'object' as const,
          properties: {
            resolvedTaskIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of tasks that are fulfilled by this email',
            },
          },
          required: ['resolvedTaskIds'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'resolve_tasks' },
    messages: [
      {
        role: 'user',
        content: `Open tasks:\n${taskList}\n\nEmail just sent:\n${sentEmailBody}`,
      },
    ],
  });

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') return [];

  const { resolvedTaskIds } = toolBlock.input as { resolvedTaskIds: string[] };

  if (resolvedTaskIds.length > 0) {
    await prisma.task.updateMany({
      where: { id: { in: resolvedTaskIds }, userId },
      data: { status: 'AUTO_RESOLVED', resolvedAt: new Date(), resolvedBy: 'auto' },
    });
  }

  return resolvedTaskIds;
}
