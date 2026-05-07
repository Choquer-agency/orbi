"use node";

// ─────────────────────────────────────────────────────────────────────────────
// meetingDetector.ts — port of services/ai/meeting-detector.ts.
//
// Internal action `detect({ emailId })` runs Claude Haiku to extract
// meeting/scheduling intent from an email and persists a `meetingDetections`
// row. Idempotent: if a detection already exists, returns it.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-haiku-4-5-20251001";

const MEETING_DETECTION_PROMPT = `Extract meeting/scheduling details from this email. Respond with JSON only, no markdown.

Extract:
- requested_times: array of {description: string, approximate_date?: string, flexibility: "specific"|"flexible"|"vague"}
- meeting_type: "call" | "video" | "in_person" | "unspecified"
- duration_hint: estimated duration in minutes (default 30 if not mentioned)
- summary: brief description of what the meeting is about (max 100 chars)
- attendees: list of people mentioned who should attend

Respond with this JSON structure:
{"requested_times": [...], "meeting_type": "string", "duration_hint": number, "summary": "string", "attendees": ["name or email"]}`;

// Backing queries/mutations live in convex/ai/meetingDetectorData.ts.

export const detect = internalAction({
  args: { emailId: v.id("emails") },
  handler: async (
    ctx,
    { emailId },
  ): Promise<unknown> => {
    const fetched = (await ctx.runQuery(
      internal.ai.meetingDetectorData._getEmailForDetection,
      { emailId },
    )) as {
      email: {
        id: Id<"emails">;
        threadId: Id<"threads">;
        subject: string;
        bodyText?: string;
        fromAddress: string;
        fromName?: string;
      };
      existing: unknown;
    } | null;
    if (!fetched) throw new Error(`Email ${emailId} not found`);
    if (fetched.existing) return fetched.existing;

    const { email } = fetched;
    const bodyPreview = (email.bodyText || "").slice(0, 1000);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: MEETING_DETECTION_PROMPT,
      messages: [
        {
          role: "user",
          content: `Subject: ${email.subject}\nFrom: ${email.fromName || ""} <${email.fromAddress}>\nBody: ${bodyPreview}\n\nToday's date: ${new Date().toISOString().split("T")[0]}`,
        },
      ],
    });

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("");

    let parsed: {
      requested_times?: unknown;
      summary?: string;
      attendees?: string[];
    };
    try {
      const jsonStr = text
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      return null;
    }

    return await ctx.runMutation(
      internal.ai.meetingDetectorData._persistDetection,
      {
        emailId,
        threadId: email.threadId,
        requestedTimes: parsed.requested_times || [],
        summary: parsed.summary || undefined,
        attendees: parsed.attendees || [],
      },
    );
  },
});
