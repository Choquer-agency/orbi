-- CreateEnum
CREATE TYPE "FollowUpWatchStatus" AS ENUM ('WATCHING', 'REPLIED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "EmailClassification" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "urgency" TEXT NOT NULL DEFAULT 'normal',
    "summary" TEXT,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "overriddenBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "assignToUserId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpWatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "intervals" INTEGER[] DEFAULT ARRAY[3, 7, 14]::INTEGER[],
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "nextCheckAt" TIMESTAMP(3) NOT NULL,
    "status" "FollowUpWatchStatus" NOT NULL DEFAULT 'WATCHING',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpWatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpEvent" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "draftBody" TEXT,
    "draftTone" TEXT,
    "openCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUpEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailClassification_emailId_key" ON "EmailClassification"("emailId");

-- CreateIndex
CREATE INDEX "EmailClassification_category_idx" ON "EmailClassification"("category");

-- CreateIndex
CREATE INDEX "EmailClassification_urgency_idx" ON "EmailClassification"("urgency");

-- CreateIndex
CREATE INDEX "RoutingRule_category_isActive_idx" ON "RoutingRule"("category", "isActive");

-- CreateIndex
CREATE INDEX "FollowUpWatch_userId_status_nextCheckAt_idx" ON "FollowUpWatch"("userId", "status", "nextCheckAt");

-- CreateIndex
CREATE INDEX "FollowUpWatch_threadId_idx" ON "FollowUpWatch"("threadId");

-- AddForeignKey
ALTER TABLE "EmailClassification" ADD CONSTRAINT "EmailClassification_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpWatch" ADD CONSTRAINT "FollowUpWatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpWatch" ADD CONSTRAINT "FollowUpWatch_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpEvent" ADD CONSTRAINT "FollowUpEvent_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "FollowUpWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
