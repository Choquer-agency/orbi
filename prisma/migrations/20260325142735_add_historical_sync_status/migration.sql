-- CreateEnum
CREATE TYPE "HistoricalSyncStatus" AS ENUM ('IDLE', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "historicalSyncCompletedAt" TIMESTAMP(3),
ADD COLUMN     "historicalSyncProgress" JSONB,
ADD COLUMN     "historicalSyncStatus" "HistoricalSyncStatus" NOT NULL DEFAULT 'IDLE';
