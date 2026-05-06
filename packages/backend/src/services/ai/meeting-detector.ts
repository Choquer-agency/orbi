import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';

const MODEL = 'claude-haiku-4-5-20251001';

const MEETING_DETECTION_PROMPT = `Extract meeting/scheduling details from this email. Respond with JSON only, no markdown.

Extract:
- requested_times: array of {description: string, approximate_date?: string, flexibility: "specific"|"flexible"|"vague"}
- meeting_type: "call" | "video" | "in_person" | "unspecified"
- duration_hint: estimated duration in minutes (default 30 if not mentioned)
- summary: brief description of what the meeting is about (max 100 chars)
- attendees: list of people mentioned who should attend

Respond with this JSON structure:
{"requested_times": [...], "meeting_type": "string", "duration_hint": number, "summary": "string", "attendees": ["name or email"]}`;

export class MeetingDetector {
  private client: Anthropic;
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    this.prisma = prisma;
  }

  async detect(emailId: string) {
    const email = await this.prisma.email.findUnique({
      where: { id: emailId },
      select: {
        id: true,
        threadId: true,
        subject: true,
        bodyText: true,
        fromAddress: true,
        fromName: true,
      },
    });

    if (!email) {
      throw new Error(`Email ${emailId} not found`);
    }

    // Check if already detected for this email
    const existing = await this.prisma.meetingDetection.findFirst({
      where: { emailId },
    });
    if (existing) return existing;

    const bodyPreview = (email.bodyText || '').slice(0, 1000);

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: MEETING_DETECTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Subject: ${email.subject}\nFrom: ${email.fromName || ''} <${email.fromAddress}>\nBody: ${bodyPreview}\n\nToday's date: ${new Date().toISOString().split('T')[0]}`,
        },
      ],
    });

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    let parsed: any;
    try {
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      return null; // Failed to parse — no meeting detected
    }

    const detection = await this.prisma.meetingDetection.create({
      data: {
        emailId,
        threadId: email.threadId,
        requestedTimes: parsed.requested_times || [],
        summary: parsed.summary || null,
        attendees: parsed.attendees || [],
      },
    });

    return detection;
  }
}
