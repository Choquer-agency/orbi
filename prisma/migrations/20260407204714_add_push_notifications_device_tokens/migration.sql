-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID');

-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN     "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "quietHoursEnd" TEXT,
ADD COLUMN     "quietHoursStart" TEXT,
ADD COLUMN     "quietHoursTimezone" TEXT,
ADD COLUMN     "showPreviewOnLock" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "bundleId" TEXT NOT NULL DEFAULT 'com.orbimail.app',
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "appVersion" TEXT,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDeliveryLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceTokenId" TEXT NOT NULL,
    "notificationId" TEXT,
    "apnsId" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "errorCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");

-- CreateIndex
CREATE INDEX "DeviceToken_token_idx" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "PushDeliveryLog_userId_createdAt_idx" ON "PushDeliveryLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PushDeliveryLog_deviceTokenId_idx" ON "PushDeliveryLog"("deviceTokenId");

-- CreateIndex
CREATE INDEX "PushDeliveryLog_status_createdAt_idx" ON "PushDeliveryLog"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
