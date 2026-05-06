-- CreateEnum
CREATE TYPE "SendStatus" AS ENUM ('NONE', 'PENDING_SEND', 'SENT', 'UNDONE');

-- CreateEnum
CREATE TYPE "ScheduledEmailStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED');

-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "sendStatus" "SendStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "undoDeadlineAt" TIMESTAMP(3),
ADD COLUMN     "undoneAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ScheduledEmail" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "threadId" TEXT,
    "parentEmailId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'compose',
    "toAddresses" JSONB NOT NULL,
    "ccAddresses" JSONB,
    "bccAddresses" JSONB,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledEmailStatus" NOT NULL DEFAULT 'SCHEDULED',
    "jobId" TEXT,
    "sentEmailId" TEXT,
    "failureReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledEmail_userId_status_sendAt_idx" ON "ScheduledEmail"("userId", "status", "sendAt");

-- CreateIndex
CREATE INDEX "ScheduledEmail_status_sendAt_idx" ON "ScheduledEmail"("status", "sendAt");

-- CreateIndex
CREATE INDEX "Email_sendStatus_undoDeadlineAt_idx" ON "Email"("sendStatus", "undoDeadlineAt");

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
