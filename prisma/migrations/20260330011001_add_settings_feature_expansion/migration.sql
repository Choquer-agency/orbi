-- AlterTable
ALTER TABLE "EmailTracking" ADD COLUMN     "linkMap" JSONB;

-- AlterTable
ALTER TABLE "OutOfOfficeDelegation" ADD COLUMN     "autoReplyScope" TEXT NOT NULL DEFAULT 'all',
ADD COLUMN     "autoReplySubject" TEXT;

-- CreateTable
CREATE TABLE "NotificationPreferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enableNewEmail" BOOLEAN NOT NULL DEFAULT true,
    "enableMention" BOOLEAN NOT NULL DEFAULT true,
    "enableComment" BOOLEAN NOT NULL DEFAULT true,
    "enableAssignment" BOOLEAN NOT NULL DEFAULT true,
    "enableSlaWarning" BOOLEAN NOT NULL DEFAULT true,
    "enableSlaBreach" BOOLEAN NOT NULL DEFAULT true,
    "desktopEnabled" BOOLEAN NOT NULL DEFAULT false,
    "soundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedSender" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailAddress" TEXT,
    "domain" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedSender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxSplit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiFilter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkClick" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "city" TEXT,

    CONSTRAINT "LinkClick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoReplyLog" (
    "id" TEXT NOT NULL,
    "delegationId" TEXT NOT NULL,
    "senderAddress" TEXT NOT NULL,
    "repliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoReplyLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snippet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "category" TEXT,
    "variables" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Snippet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreferences_userId_key" ON "NotificationPreferences"("userId");

-- CreateIndex
CREATE INDEX "BlockedSender_userId_idx" ON "BlockedSender"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedSender_userId_emailAddress_key" ON "BlockedSender"("userId", "emailAddress");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedSender_userId_domain_key" ON "BlockedSender"("userId", "domain");

-- CreateIndex
CREATE INDEX "InboxSplit_userId_isEnabled_position_idx" ON "InboxSplit"("userId", "isEnabled", "position");

-- CreateIndex
CREATE UNIQUE INDEX "InboxSplit_userId_category_key" ON "InboxSplit"("userId", "category");

-- CreateIndex
CREATE INDEX "AiFilter_userId_isActive_idx" ON "AiFilter"("userId", "isActive");

-- CreateIndex
CREATE INDEX "LinkClick_trackingId_clickedAt_idx" ON "LinkClick"("trackingId", "clickedAt");

-- CreateIndex
CREATE INDEX "AutoReplyLog_delegationId_senderAddress_idx" ON "AutoReplyLog"("delegationId", "senderAddress");

-- CreateIndex
CREATE UNIQUE INDEX "AutoReplyLog_delegationId_senderAddress_key" ON "AutoReplyLog"("delegationId", "senderAddress");

-- CreateIndex
CREATE INDEX "Snippet_userId_category_idx" ON "Snippet"("userId", "category");

-- AddForeignKey
ALTER TABLE "NotificationPreferences" ADD CONSTRAINT "NotificationPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedSender" ADD CONSTRAINT "BlockedSender_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxSplit" ADD CONSTRAINT "InboxSplit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFilter" ADD CONSTRAINT "AiFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkClick" ADD CONSTRAINT "LinkClick_trackingId_fkey" FOREIGN KEY ("trackingId") REFERENCES "EmailTracking"("trackingId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoReplyLog" ADD CONSTRAINT "AutoReplyLog_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "OutOfOfficeDelegation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
