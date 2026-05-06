-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "DelegatedEmailStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'RETURNED');

-- CreateTable
CREATE TABLE "ThreadHandoff" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "note" TEXT,
    "transferSla" BOOLEAN NOT NULL DEFAULT false,
    "transferFollowUps" BOOLEAN NOT NULL DEFAULT false,
    "status" "HandoffStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutOfOfficeDelegation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delegateId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyBody" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "categories" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutOfOfficeDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegatedEmail" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "delegatedToId" TEXT NOT NULL,
    "status" "DelegatedEmailStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegatedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ThreadHandoff_toUserId_status_idx" ON "ThreadHandoff"("toUserId", "status");

-- CreateIndex
CREATE INDEX "ThreadHandoff_threadId_idx" ON "ThreadHandoff"("threadId");

-- CreateIndex
CREATE INDEX "OutOfOfficeDelegation_userId_isActive_idx" ON "OutOfOfficeDelegation"("userId", "isActive");

-- CreateIndex
CREATE INDEX "DelegatedEmail_delegatedToId_status_idx" ON "DelegatedEmail"("delegatedToId", "status");

-- AddForeignKey
ALTER TABLE "ThreadHandoff" ADD CONSTRAINT "ThreadHandoff_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadHandoff" ADD CONSTRAINT "ThreadHandoff_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadHandoff" ADD CONSTRAINT "ThreadHandoff_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutOfOfficeDelegation" ADD CONSTRAINT "OutOfOfficeDelegation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutOfOfficeDelegation" ADD CONSTRAINT "OutOfOfficeDelegation_delegateId_fkey" FOREIGN KEY ("delegateId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedEmail" ADD CONSTRAINT "DelegatedEmail_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedEmail" ADD CONSTRAINT "DelegatedEmail_delegatedToId_fkey" FOREIGN KEY ("delegatedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
