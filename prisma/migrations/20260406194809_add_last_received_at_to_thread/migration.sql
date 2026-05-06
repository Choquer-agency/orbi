-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "lastReceivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Thread_accountId_lastReceivedAt_idx" ON "Thread"("accountId", "lastReceivedAt" DESC);
