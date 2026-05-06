-- CreateEnum
CREATE TYPE "MeetingDetectionStatus" AS ENUM ('DETECTED', 'AVAILABILITY_CHECKED', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateTable
CREATE TABLE "EmailTracking" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailTracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOpen" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "city" TEXT,

    CONSTRAINT "EmailOpen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingDetection" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "status" "MeetingDetectionStatus" NOT NULL DEFAULT 'DETECTED',
    "requestedTimes" JSONB,
    "selectedTime" TIMESTAMP(3),
    "calendarEventId" TEXT,
    "summary" TEXT,
    "attendees" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingDetection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailTracking_emailId_key" ON "EmailTracking"("emailId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTracking_trackingId_key" ON "EmailTracking"("trackingId");

-- CreateIndex
CREATE INDEX "EmailOpen_trackingId_openedAt_idx" ON "EmailOpen"("trackingId", "openedAt");

-- CreateIndex
CREATE INDEX "MeetingDetection_threadId_idx" ON "MeetingDetection"("threadId");

-- CreateIndex
CREATE INDEX "MeetingDetection_status_idx" ON "MeetingDetection"("status");

-- AddForeignKey
ALTER TABLE "EmailTracking" ADD CONSTRAINT "EmailTracking_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailOpen" ADD CONSTRAINT "EmailOpen_trackingId_fkey" FOREIGN KEY ("trackingId") REFERENCES "EmailTracking"("trackingId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingDetection" ADD CONSTRAINT "MeetingDetection_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingDetection" ADD CONSTRAINT "MeetingDetection_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
