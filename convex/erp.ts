// ERP integration — feeds the Choquer ERP client Vault.
//
// Two pieces:
//  1. A self-chaining walker that keeps `emailParticipants` in sync with the
//     `emails` table (cron kicks it; it batches through everything new since
//     the stored cursor, so the first run doubles as the backfill).
//  2. An internal query the /erp/messages HTTP route uses to answer
//     "every message where <address|domain> was a participant".

import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

const BATCH = 200;

type Addr = { email?: string; name?: string };

function participantsOf(email: Doc<"emails">): { address: string; name?: string; role: string }[] {
  const out: { address: string; name?: string; role: string }[] = [];
  const push = (addr: string | undefined, name: string | undefined, role: string) => {
    const a = (addr ?? "").trim().toLowerCase();
    if (!a || !a.includes("@")) return;
    out.push({ address: a, name: name || undefined, role });
  };
  push(email.fromAddress, email.fromName ?? undefined, "from");
  for (const [role, list] of [
    ["to", email.toAddresses],
    ["cc", email.ccAddresses],
    ["bcc", email.bccAddresses],
  ] as const) {
    if (Array.isArray(list)) {
      for (const a of list as Addr[]) push(a?.email, a?.name, role);
    }
  }
  return out;
}

export const indexParticipants = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db
      .query("erpState")
      .withIndex("by_key", (q) => q.eq("key", "participantCursor"))
      .unique();
    const cursor = (state?.value as number | undefined) ?? 0;

    const batch = await ctx.db
      .query("emails")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
      .order("asc")
      .take(BATCH);
    if (batch.length === 0) return { processed: 0, done: true };

    // Own-address cache: direction is "out" iff the sender is the mailbox's
    // own address or one of its aliases (labels/sendStatus proved unreliable).
    const ownAddresses = new Map<string, Set<string>>();
    const ownFor = async (accountId: (typeof batch)[number]["accountId"]) => {
      const key = accountId as unknown as string;
      let set = ownAddresses.get(key);
      if (!set) {
        const account = await ctx.db.get(accountId);
        set = new Set(
          [account?.email, ...((account?.aliases as string[] | undefined) ?? [])]
            .filter((a): a is string => !!a)
            .map((a) => a.toLowerCase())
        );
        ownAddresses.set(key, set);
      }
      return set;
    };

    for (const email of batch) {
      if (email.isDraft) continue;
      // Idempotent: clear any existing rows for this email before re-writing.
      const existing = await ctx.db
        .query("emailParticipants")
        .withIndex("by_email", (q) => q.eq("emailId", email._id))
        .collect();
      for (const row of existing) await ctx.db.delete(row._id);

      const own = await ownFor(email.accountId);
      const direction = own.has((email.fromAddress ?? "").toLowerCase()) ? "out" : "in";
      const receivedAt = email.receivedAt ?? email.sentAt ?? email._creationTime;
      for (const p of participantsOf(email)) {
        await ctx.db.insert("emailParticipants", {
          emailId: email._id,
          threadId: email.threadId,
          accountId: email.accountId,
          address: p.address,
          domain: p.address.split("@")[1] ?? "",
          name: p.name,
          role: p.role,
          direction,
          receivedAt,
        });
      }
    }

    const newCursor = batch[batch.length - 1]._creationTime;
    if (state) await ctx.db.patch(state._id, { value: newCursor });
    else await ctx.db.insert("erpState", { key: "participantCursor", value: newCursor });

    // More to do — chain another batch immediately (this is how the initial
    // backfill drains without a long-running job).
    if (batch.length === BATCH) {
      await ctx.scheduler.runAfter(50, internal.erp.indexParticipants, {});
    }
    return { processed: batch.length, done: batch.length < BATCH };
  },
});

// Ops tool: wipe the cursor so the next indexParticipants run re-walks the
// whole emails table (rows are rewritten idempotently).
export const resetParticipantCursor = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db
      .query("erpState")
      .withIndex("by_key", (q) => q.eq("key", "participantCursor"))
      .unique();
    if (state) await ctx.db.delete(state._id);
    await ctx.scheduler.runAfter(0, internal.erp.indexParticipants, {});
    return "reset";
  },
});

export const messagesForParticipant = internalQuery({
  args: {
    address: v.optional(v.string()),
    domain: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    let rows;
    if (args.address) {
      const address = args.address.trim().toLowerCase();
      rows = await ctx.db
        .query("emailParticipants")
        .withIndex("by_address_receivedAt", (q) => q.eq("address", address))
        .order("desc")
        .take(limit * 4);
    } else if (args.domain) {
      const domain = args.domain.trim().toLowerCase();
      rows = await ctx.db
        .query("emailParticipants")
        .withIndex("by_domain_receivedAt", (q) => q.eq("domain", domain))
        .order("desc")
        .take(limit * 4);
    } else {
      return [];
    }

    // A message matches once even if the address appears in to+cc; dedupe.
    const seen = new Set<string>();
    const messages: unknown[] = [];
    for (const row of rows) {
      if (seen.has(row.emailId)) continue;
      seen.add(row.emailId);
      const email = await ctx.db.get(row.emailId);
      if (!email || email.isDraft) continue;
      messages.push({
        id: email._id,
        messageId: email.internetMessageId ?? null,
        threadId: email.threadId,
        subject: email.subject ?? "",
        snippet: email.snippet ?? "",
        from: { address: email.fromAddress, name: email.fromName ?? null },
        to: Array.isArray(email.toAddresses) ? email.toAddresses : [],
        direction: row.direction,
        date: email.receivedAt ?? email.sentAt ?? email._creationTime,
      });
      if (messages.length >= limit) break;
    }
    return messages;
  },
});
