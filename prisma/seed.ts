import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('orbi2024', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@orbi.agency' },
    update: {},
    create: {
      email: 'admin@orbi.agency',
      name: 'Admin',
      passwordHash,
      role: 'ADMIN',
    },
  });

  const agent1 = await prisma.user.upsert({
    where: { email: 'sarah@orbi.agency' },
    update: {},
    create: {
      email: 'sarah@orbi.agency',
      name: 'Sarah Chen',
      passwordHash,
      role: 'AGENT',
    },
  });

  const agent2 = await prisma.user.upsert({
    where: { email: 'mike@orbi.agency' },
    update: {},
    create: {
      email: 'mike@orbi.agency',
      name: 'Mike Johnson',
      passwordHash,
      role: 'AGENT',
    },
  });

  // Create default signatures
  await prisma.signature.upsert({
    where: { id: 'default-admin-sig' },
    update: {},
    create: {
      id: 'default-admin-sig',
      userId: admin.id,
      name: 'Default',
      bodyHtml: '<p>Best regards,<br/>Admin<br/>Orbi Agency</p>',
      isDefault: true,
    },
  });

  await prisma.signature.upsert({
    where: { id: 'default-sarah-sig' },
    update: {},
    create: {
      id: 'default-sarah-sig',
      userId: agent1.id,
      name: 'Default',
      bodyHtml: '<p>Best regards,<br/>Sarah Chen<br/>Orbi Agency</p>',
      isDefault: true,
    },
  });

  await prisma.signature.upsert({
    where: { id: 'default-mike-sig' },
    update: {},
    create: {
      id: 'default-mike-sig',
      userId: agent2.id,
      name: 'Default',
      bodyHtml: '<p>Best regards,<br/>Mike Johnson<br/>Orbi Agency</p>',
      isDefault: true,
    },
  });

  // Create default writing preferences
  for (const user of [admin, agent1, agent2]) {
    await prisma.writingPreferences.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        greetingStyle: 'Hey',
        signOffStyle: 'Best',
        tone: 3,
        verbosity: 3,
        descriptors: ['professional', 'friendly'],
        customRules: [],
      },
    });
  }

  console.log('Seeded users:', { admin: admin.email, agent1: agent1.email, agent2: agent2.email });

  // ── Create a demo account for seeding threads ──
  const demoAccount = await prisma.account.upsert({
    where: { provider_email: { provider: 'GMAIL', email: 'admin@orbi.agency' } },
    update: {},
    create: {
      userId: admin.id,
      provider: 'GMAIL',
      email: 'admin@orbi.agency',
      displayName: 'Admin — Orbi Agency',
      accessToken: 'demo-token',
      scopes: ['https://mail.google.com/'],
    },
  });

  // ── Clear old seed threads to avoid duplicates ──
  await prisma.email.deleteMany({ where: { account: { id: demoAccount.id } } });
  await prisma.thread.deleteMany({ where: { accountId: demoAccount.id } });

  const now = new Date();
  const hours = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
  const days = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

  // ────────────────────────────────────────────────
  // Thread 1 — SHORT (1 email, today)
  // ────────────────────────────────────────────────
  const thread1 = await prisma.thread.create({
    data: {
      accountId: demoAccount.id,
      providerThreadId: 'seed-thread-short',
      subject: 'Quick question about the invoice',
      snippet: 'Hey, just wanted to check — did you get the updated invoice I sent over on Friday?',
      isRead: false,
      messageCount: 1,
      participantEmails: ['rachel@luminadesign.co', 'admin@orbi.agency'],
      lastMessageAt: hours(2),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread1.id,
      providerMessageId: 'seed-email-short-1',
      fromAddress: 'rachel@luminadesign.co',
      fromName: 'Rachel Kim',
      toAddresses: [{ email: 'admin@orbi.agency', name: 'Admin' }],
      subject: 'Quick question about the invoice',
      bodyText: 'Hey,\n\nJust wanted to check — did you get the updated invoice I sent over on Friday? The total changed slightly because of the extra revision round.\n\nLet me know if you need me to resend it.\n\nThanks!\nRachel',
      bodyHtml: '<p>Hey,</p><p>Just wanted to check — did you get the updated invoice I sent over on Friday? The total changed slightly because of the extra revision round.</p><p>Let me know if you need me to resend it.</p><p>Thanks!<br/>Rachel</p>',
      snippet: 'Hey, just wanted to check — did you get the updated invoice I sent over on Friday?',
      receivedAt: hours(2),
    },
  });

  // ────────────────────────────────────────────────
  // Thread 2 — MEDIUM (3 emails, yesterday)
  // ────────────────────────────────────────────────
  const thread2 = await prisma.thread.create({
    data: {
      accountId: demoAccount.id,
      providerThreadId: 'seed-thread-medium',
      subject: 'Re: Brand refresh — logo concepts round 2',
      snippet: 'These are looking great. I think option B is the strongest.',
      isRead: true,
      isStarred: true,
      messageCount: 3,
      participantEmails: ['daniel@northstarventures.com', 'admin@orbi.agency', 'sarah@orbi.agency'],
      lastMessageAt: days(1),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread2.id,
      providerMessageId: 'seed-email-med-1',
      fromAddress: 'daniel@northstarventures.com',
      fromName: 'Daniel Park',
      toAddresses: [{ email: 'admin@orbi.agency', name: 'Admin' }, { email: 'sarah@orbi.agency', name: 'Sarah Chen' }],
      subject: 'Brand refresh — logo concepts round 2',
      bodyText: 'Hi team,\n\nAttaching the second round of logo concepts based on your feedback from last week. We\'ve narrowed it down to three directions:\n\n• Option A — Minimal wordmark with geometric accent\n• Option B — Abstract monogram with gradient treatment\n• Option C — Full logotype with custom letterforms\n\nWould love to get your thoughts by end of week so we can move into color exploration.\n\nBest,\nDaniel',
      bodyHtml: '<p>Hi team,</p><p>Attaching the second round of logo concepts based on your feedback from last week. We\'ve narrowed it down to three directions:</p><ul><li><strong>Option A</strong> — Minimal wordmark with geometric accent</li><li><strong>Option B</strong> — Abstract monogram with gradient treatment</li><li><strong>Option C</strong> — Full logotype with custom letterforms</li></ul><p>Would love to get your thoughts by end of week so we can move into color exploration.</p><p>Best,<br/>Daniel</p>',
      snippet: 'Attaching the second round of logo concepts based on your feedback from last week.',
      receivedAt: days(2),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread2.id,
      providerMessageId: 'seed-email-med-2',
      fromAddress: 'admin@orbi.agency',
      fromName: 'Admin',
      toAddresses: [{ email: 'daniel@northstarventures.com', name: 'Daniel Park' }, { email: 'sarah@orbi.agency', name: 'Sarah Chen' }],
      subject: 'Re: Brand refresh — logo concepts round 2',
      bodyText: 'Daniel,\n\nThese are looking great. I think option B is the strongest — the monogram feels modern and versatile. Could we see it in a darker palette as well? Thinking navy + gold instead of the current blue.\n\nOption C is also interesting but feels a bit too editorial for their brand.\n\nSarah, what do you think?\n\nBest,\nAdmin',
      bodyHtml: '<p>Daniel,</p><p>These are looking great. I think option B is the strongest — the monogram feels modern and versatile. Could we see it in a darker palette as well? Thinking navy + gold instead of the current blue.</p><p>Option C is also interesting but feels a bit too editorial for their brand.</p><p>Sarah, what do you think?</p><p>Best,<br/>Admin</p>',
      snippet: 'These are looking great. I think option B is the strongest.',
      receivedAt: days(1).getTime() + 3 * 60 * 60 * 1000 > now.getTime() ? days(1) : new Date(days(1).getTime() + 3 * 60 * 60 * 1000),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread2.id,
      providerMessageId: 'seed-email-med-3',
      fromAddress: 'sarah@orbi.agency',
      fromName: 'Sarah Chen',
      toAddresses: [{ email: 'admin@orbi.agency', name: 'Admin' }, { email: 'daniel@northstarventures.com', name: 'Daniel Park' }],
      subject: 'Re: Brand refresh — logo concepts round 2',
      bodyText: 'Agreed — Option B is the clear winner. The gradient gives it a lot of flexibility across digital and print.\n\nDaniel, +1 on the navy/gold palette. Also curious if we can test it on a dark background? Their app has a dark mode so we\'ll need it to work both ways.\n\nLet\'s aim to lock the direction by Thursday.\n\n— Sarah',
      bodyHtml: '<p>Agreed — Option B is the clear winner. The gradient gives it a lot of flexibility across digital and print.</p><p>Daniel, +1 on the navy/gold palette. Also curious if we can test it on a dark background? Their app has a dark mode so we\'ll need it to work both ways.</p><p>Let\'s aim to lock the direction by Thursday.</p><p>— Sarah</p>',
      snippet: 'Agreed — Option B is the clear winner.',
      receivedAt: days(1),
    },
  });

  // Internal comment on thread 2 — between email 1 (day 2) and email 2 (day 1 + 3h)
  await prisma.threadComment.create({
    data: {
      threadId: thread2.id,
      authorId: admin.id,
      bodyHtml: '<p>Let\'s push for Option B. Client seemed excited about gradients in the last call.</p>',
      bodyText: 'Let\'s push for Option B. Client seemed excited about gradients in the last call.',
      createdAt: new Date(days(2).getTime() + 5 * 60 * 60 * 1000), // 5 hours after Daniel's email
    },
  });

  // ────────────────────────────────────────────────
  // Thread 3 — LONG (6 emails, spanning several days)
  // ────────────────────────────────────────────────
  const thread3 = await prisma.thread.create({
    data: {
      accountId: demoAccount.id,
      providerThreadId: 'seed-thread-long',
      subject: 'Re: Website launch — final checklist and timeline',
      snippet: 'All pages are QA\'d. Deploying to staging tonight for final client review.',
      isRead: false,
      isStarred: true,
      messageCount: 6,
      participantEmails: ['admin@orbi.agency', 'tom@hollowaygroup.com', 'sarah@orbi.agency', 'mike@orbi.agency', 'priya@hollowaygroup.com'],
      lastMessageAt: hours(5),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread3.id,
      providerMessageId: 'seed-email-long-1',
      fromAddress: 'tom@hollowaygroup.com',
      fromName: 'Tom Holloway',
      toAddresses: [{ email: 'admin@orbi.agency', name: 'Admin' }],
      ccAddresses: [{ email: 'priya@hollowaygroup.com', name: 'Priya Mehta' }],
      subject: 'Website launch — final checklist and timeline',
      bodyText: 'Hi Admin,\n\nWe\'re coming up on our March 15 launch date and I want to make sure we\'re all aligned. Here\'s where I think we stand:\n\n1. Homepage — Final copy approved, hero animation done\n2. About page — Team photos still needed from Priya\n3. Services page — Looks good, just needs the pricing table\n4. Contact form — Working but needs the CRM integration\n5. Blog — Template done, 3 launch posts drafted\n\nCan you confirm your team\'s timeline for the remaining items? We\'re planning to do a soft launch on the 13th for internal review.\n\nThanks,\nTom',
      bodyHtml: '<p>Hi Admin,</p><p>We\'re coming up on our March 15 launch date and I want to make sure we\'re all aligned. Here\'s where I think we stand:</p><ol><li><strong>Homepage</strong> — Final copy approved, hero animation done</li><li><strong>About page</strong> — Team photos still needed from Priya</li><li><strong>Services page</strong> — Looks good, just needs the pricing table</li><li><strong>Contact form</strong> — Working but needs the CRM integration</li><li><strong>Blog</strong> — Template done, 3 launch posts drafted</li></ol><p>Can you confirm your team\'s timeline for the remaining items? We\'re planning to do a soft launch on the 13th for internal review.</p><p>Thanks,<br/>Tom</p>',
      snippet: 'We\'re coming up on our March 15 launch date and I want to make sure we\'re all aligned.',
      receivedAt: days(5),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread3.id,
      providerMessageId: 'seed-email-long-2',
      fromAddress: 'admin@orbi.agency',
      fromName: 'Admin',
      toAddresses: [{ email: 'tom@hollowaygroup.com', name: 'Tom Holloway' }],
      ccAddresses: [{ email: 'sarah@orbi.agency', name: 'Sarah Chen' }, { email: 'mike@orbi.agency', name: 'Mike Johnson' }],
      subject: 'Re: Website launch — final checklist and timeline',
      bodyText: 'Tom,\n\nGreat summary. Here\'s our status on the remaining items:\n\n• Pricing table — Mike is finishing this today, should be in staging by tomorrow\n• CRM integration — Sarah has the HubSpot connector ready, just needs the API key from your side\n• About page photos — Waiting on Priya. Can we get those by Wednesday at the latest?\n\nThe soft launch on the 13th works for us. We\'ll have everything on staging by the 12th EOD.\n\nBest,\nAdmin',
      bodyHtml: '<p>Tom,</p><p>Great summary. Here\'s our status on the remaining items:</p><ul><li><strong>Pricing table</strong> — Mike is finishing this today, should be in staging by tomorrow</li><li><strong>CRM integration</strong> — Sarah has the HubSpot connector ready, just needs the API key from your side</li><li><strong>About page photos</strong> — Waiting on Priya. Can we get those by Wednesday at the latest?</li></ul><p>The soft launch on the 13th works for us. We\'ll have everything on staging by the 12th EOD.</p><p>Best,<br/>Admin</p>',
      snippet: 'Here\'s our status on the remaining items.',
      receivedAt: days(4),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread3.id,
      providerMessageId: 'seed-email-long-3',
      fromAddress: 'priya@hollowaygroup.com',
      fromName: 'Priya Mehta',
      toAddresses: [{ email: 'admin@orbi.agency', name: 'Admin' }, { email: 'tom@hollowaygroup.com', name: 'Tom Holloway' }],
      subject: 'Re: Website launch — final checklist and timeline',
      bodyText: 'Hi all,\n\nSorry for the delay on the team photos! Our photographer had to reschedule. New shoot is tomorrow morning — I\'ll have edited photos to you by Wednesday noon.\n\nAlso, Tom — I\'ll send the HubSpot API key in a separate email today.\n\nPriya',
      bodyHtml: '<p>Hi all,</p><p>Sorry for the delay on the team photos! Our photographer had to reschedule. New shoot is tomorrow morning — I\'ll have edited photos to you by Wednesday noon.</p><p>Also, Tom — I\'ll send the HubSpot API key in a separate email today.</p><p>Priya</p>',
      snippet: 'Sorry for the delay on the team photos! Our photographer had to reschedule.',
      receivedAt: days(3),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread3.id,
      providerMessageId: 'seed-email-long-4',
      fromAddress: 'mike@orbi.agency',
      fromName: 'Mike Johnson',
      toAddresses: [{ email: 'tom@hollowaygroup.com', name: 'Tom Holloway' }, { email: 'admin@orbi.agency', name: 'Admin' }],
      subject: 'Re: Website launch — final checklist and timeline',
      bodyText: 'Quick update — pricing table is done and deployed to staging. Three tiers: Starter, Growth, Enterprise. Each has a feature comparison and a CTA button.\n\nTom, can you review when you get a chance? Specifically want to confirm the Enterprise pricing is listed as "Contact us" per your last email.\n\nStaging link: https://staging.hollowaygroup.com/services\n\n— Mike',
      bodyHtml: '<p>Quick update — pricing table is done and deployed to staging. Three tiers: Starter, Growth, Enterprise. Each has a feature comparison and a CTA button.</p><p>Tom, can you review when you get a chance? Specifically want to confirm the Enterprise pricing is listed as "Contact us" per your last email.</p><p>Staging link: <a href="https://staging.hollowaygroup.com/services">https://staging.hollowaygroup.com/services</a></p><p>— Mike</p>',
      snippet: 'Quick update — pricing table is done and deployed to staging.',
      receivedAt: days(2),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread3.id,
      providerMessageId: 'seed-email-long-5',
      fromAddress: 'sarah@orbi.agency',
      fromName: 'Sarah Chen',
      toAddresses: [{ email: 'admin@orbi.agency', name: 'Admin' }, { email: 'tom@hollowaygroup.com', name: 'Tom Holloway' }],
      subject: 'Re: Website launch — final checklist and timeline',
      bodyText: 'CRM integration is live on staging. Contact form submissions are flowing into HubSpot correctly — tested with 3 dummy entries.\n\nOne thing to note: the form has a honeypot field for spam protection. If you\'re testing, make sure to leave the "company_url" field empty (it\'s hidden from real users).\n\nAlso set up email notifications so Tom gets an alert for every new submission.\n\n— Sarah',
      bodyHtml: '<p>CRM integration is live on staging. Contact form submissions are flowing into HubSpot correctly — tested with 3 dummy entries.</p><p>One thing to note: the form has a honeypot field for spam protection. If you\'re testing, make sure to leave the "company_url" field empty (it\'s hidden from real users).</p><p>Also set up email notifications so Tom gets an alert for every new submission.</p><p>— Sarah</p>',
      snippet: 'CRM integration is live on staging. Contact form submissions are flowing into HubSpot correctly.',
      receivedAt: days(1),
    },
  });

  await prisma.email.create({
    data: {
      accountId: demoAccount.id,
      threadId: thread3.id,
      providerMessageId: 'seed-email-long-6',
      fromAddress: 'tom@hollowaygroup.com',
      fromName: 'Tom Holloway',
      toAddresses: [{ email: 'admin@orbi.agency', name: 'Admin' }, { email: 'sarah@orbi.agency', name: 'Sarah Chen' }, { email: 'mike@orbi.agency', name: 'Mike Johnson' }],
      subject: 'Re: Website launch — final checklist and timeline',
      bodyText: 'This is all coming together nicely. Pricing table looks perfect Mike — yes, Enterprise should stay as "Contact us."\n\nSarah, CRM integration is working great on my end. Got the test notifications.\n\nPriya sent the team photos over this morning. I\'ve uploaded them to the shared drive.\n\nI think we\'re on track. All pages are QA\'d. Let\'s plan on deploying to staging tonight for final client review tomorrow, then go live on the 15th as planned.\n\nExcited to get this one across the finish line!\n\nTom',
      bodyHtml: '<p>This is all coming together nicely. Pricing table looks perfect Mike — yes, Enterprise should stay as "Contact us."</p><p>Sarah, CRM integration is working great on my end. Got the test notifications.</p><p>Priya sent the team photos over this morning. I\'ve uploaded them to the shared drive.</p><p>I think we\'re on track. All pages are QA\'d. Let\'s plan on deploying to staging tonight for final client review tomorrow, then go live on the 15th as planned.</p><p>Excited to get this one across the finish line!</p><p>Tom</p>',
      snippet: 'All pages are QA\'d. Deploying to staging tonight for final client review.',
      receivedAt: hours(5),
    },
  });

  // Internal comments on thread 3 — placed BETWEEN emails in the timeline
  // Between email 2 (day 4) and email 3 (day 3): Admin and Mike discuss internally
  await prisma.threadComment.create({
    data: {
      threadId: thread3.id,
      authorId: admin.id,
      bodyHtml: '<p>Mike, can you prioritize the pricing table today? Tom seems anxious about the timeline.</p>',
      bodyText: 'Mike, can you prioritize the pricing table today? Tom seems anxious about the timeline.',
      createdAt: new Date(days(4).getTime() + 2 * 60 * 60 * 1000), // 2 hours after email 2
    },
  });

  await prisma.threadComment.create({
    data: {
      threadId: thread3.id,
      authorId: agent2.id,
      bodyHtml: '<p>On it. I\'ll have the three-tier layout done by EOD. Should I go with the card-style design or the comparison table?</p>',
      bodyText: "On it. I'll have the three-tier layout done by EOD. Should I go with the card-style design or the comparison table?",
      createdAt: new Date(days(4).getTime() + 3 * 60 * 60 * 1000),
    },
  });

  await prisma.threadComment.create({
    data: {
      threadId: thread3.id,
      authorId: admin.id,
      bodyHtml: '<p>Comparison table — matches their existing brand guidelines better. Keep Enterprise as "Contact us" for pricing.</p>',
      bodyText: 'Comparison table — matches their existing brand guidelines better. Keep Enterprise as "Contact us" for pricing.',
      createdAt: new Date(days(4).getTime() + 3.5 * 60 * 60 * 1000),
    },
  });

  // Between email 5 (day 1, Sarah's CRM update) and email 6 (hours 5): Sarah flags something
  await prisma.threadComment.create({
    data: {
      threadId: thread3.id,
      authorId: agent1.id,
      bodyHtml: '<p>Heads up — the honeypot field might confuse their QA team. Should we add a note in the handoff doc?</p>',
      bodyText: "Heads up — the honeypot field might confuse their QA team. Should we add a note in the handoff doc?",
      createdAt: new Date(days(1).getTime() + 4 * 60 * 60 * 1000),
    },
  });

  await prisma.threadComment.create({
    data: {
      threadId: thread3.id,
      authorId: admin.id,
      bodyHtml: '<p>Good call. Add it to the launch checklist doc. I\'ll mention it to Tom in the next reply.</p>',
      bodyText: "Good call. Add it to the launch checklist doc. I'll mention it to Tom in the next reply.",
      createdAt: new Date(days(1).getTime() + 5 * 60 * 60 * 1000),
    },
  });

  // ── Seed Tasks for Dashboard ──
  await prisma.task.deleteMany({ where: { userId: admin.id } });

  await prisma.task.createMany({
    data: [
      {
        userId: admin.id,
        threadId: thread1.id,
        description: 'Confirm receipt of updated invoice from Rachel',
        contactEmail: 'rachel@luminadesign.co',
        contactName: 'Rachel Kim',
        taskType: 'DEADLINE',
        deadline: new Date(now.getTime() + 0), // due today
        status: 'OPEN',
      },
      {
        userId: admin.id,
        threadId: thread2.id,
        description: 'Lock logo direction by Thursday',
        contactEmail: 'daniel@northstarventures.com',
        contactName: 'Daniel Park',
        taskType: 'DEADLINE',
        deadline: days(-2), // 2 days from now
        status: 'OPEN',
      },
      {
        userId: admin.id,
        threadId: thread2.id,
        description: 'Request navy + gold palette from Daniel',
        contactEmail: 'daniel@northstarventures.com',
        contactName: 'Daniel Park',
        taskType: 'CHANGE_REQUEST',
        status: 'OPEN',
      },
      {
        userId: admin.id,
        threadId: thread3.id,
        description: 'Deploy everything to staging by March 12 EOD',
        contactEmail: 'tom@hollowaygroup.com',
        contactName: 'Tom Holloway',
        taskType: 'PROMISE',
        deadline: days(-2), // March 12
        status: 'OPEN',
      },
      {
        userId: admin.id,
        threadId: thread3.id,
        description: 'Add honeypot note to launch checklist doc',
        contactEmail: 'sarah@orbi.agency',
        contactName: 'Sarah Chen',
        taskType: 'ACTION_ITEM',
        status: 'OPEN',
      },
      {
        userId: admin.id,
        threadId: thread3.id,
        description: 'Mention honeypot field to Tom in next reply',
        contactEmail: 'tom@hollowaygroup.com',
        contactName: 'Tom Holloway',
        taskType: 'ACTION_ITEM',
        status: 'OPEN',
      },
      {
        userId: admin.id,
        threadId: thread3.id,
        description: 'Get team photos from Priya by Wednesday',
        contactEmail: 'priya@hollowaygroup.com',
        contactName: 'Priya Mehta',
        taskType: 'DEADLINE',
        deadline: days(1), // was due yesterday
        status: 'AUTO_RESOLVED',
        resolvedAt: hours(5),
        resolvedBy: 'auto',
      },
      {
        userId: admin.id,
        threadId: thread3.id,
        description: 'Finish and deploy pricing table to staging',
        contactEmail: 'tom@hollowaygroup.com',
        contactName: 'Tom Holloway',
        taskType: 'PROMISE',
        deadline: days(3),
        status: 'DONE',
        resolvedAt: days(2),
        resolvedBy: 'manual',
      },
    ],
  });

  console.log('Seeded threads:', { short: thread1.id, medium: thread2.id, long: thread3.id });
  console.log('Seeded 8 tasks for dashboard');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
