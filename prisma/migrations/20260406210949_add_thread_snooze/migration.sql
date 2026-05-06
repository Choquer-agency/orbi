/*
  Warnings:

  - You are about to drop the column `accountId` on the `Signature` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SNOOZE_REMINDER';

-- DropForeignKey
ALTER TABLE "OutOfOfficeDelegation" DROP CONSTRAINT "OutOfOfficeDelegation_delegateId_fkey";

-- DropForeignKey
ALTER TABLE "Signature" DROP CONSTRAINT "Signature_accountId_fkey";

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "content" BYTEA,
ALTER COLUMN "providerAttachmentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN     "enableSnoozeReminder" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "OutOfOfficeDelegation" ALTER COLUMN "delegateId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Signature" DROP COLUMN "accountId",
ADD COLUMN     "accountIds" TEXT[];

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "snoozedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Thread_accountId_snoozedUntil_idx" ON "Thread"("accountId", "snoozedUntil");

-- AddForeignKey
ALTER TABLE "OutOfOfficeDelegation" ADD CONSTRAINT "OutOfOfficeDelegation_delegateId_fkey" FOREIGN KEY ("delegateId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
