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

  console.log('Seeded users:', { admin: admin.email, agent1: agent1.email, agent2: agent2.email });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
