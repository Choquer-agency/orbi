-- CreateTable
CREATE TABLE "TriageFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "suggestedCategory" TEXT NOT NULL,
    "finalCategory" TEXT NOT NULL,
    "wasConfirmed" BOOLEAN NOT NULL,
    "senderAddress" TEXT NOT NULL,
    "subjectSnippet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "autoSortEnabled" BOOLEAN NOT NULL DEFAULT false,
    "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriageSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingExclusion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriageFeedback_userId_createdAt_idx" ON "TriageFeedback"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TriageFeedback_userId_senderAddress_idx" ON "TriageFeedback"("userId", "senderAddress");

-- CreateIndex
CREATE UNIQUE INDEX "TriageSettings_userId_key" ON "TriageSettings"("userId");

-- CreateIndex
CREATE INDEX "TrackingExclusion_userId_idx" ON "TrackingExclusion"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingExclusion_userId_emailAddress_key" ON "TrackingExclusion"("userId", "emailAddress");

-- AddForeignKey
ALTER TABLE "TriageFeedback" ADD CONSTRAINT "TriageFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageSettings" ADD CONSTRAINT "TriageSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingExclusion" ADD CONSTRAINT "TrackingExclusion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
