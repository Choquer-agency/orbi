-- CreateTable
CREATE TABLE "WritingPreferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "greetingStyle" TEXT,
    "signOffStyle" TEXT,
    "tone" INTEGER NOT NULL DEFAULT 3,
    "verbosity" INTEGER NOT NULL DEFAULT 3,
    "descriptors" TEXT[],
    "customRules" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WritingPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactStyle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactName" TEXT,
    "tone" INTEGER,
    "verbosity" INTEGER,
    "greetingStyle" TEXT,
    "signOffStyle" TEXT,
    "notes" TEXT,
    "isAutoLearned" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactStyle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleCorrection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contactEmail" TEXT,
    "category" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "editedText" TEXT NOT NULL,
    "summary" TEXT,
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StyleCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WritingPreferences_userId_key" ON "WritingPreferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactStyle_userId_contactEmail_key" ON "ContactStyle"("userId", "contactEmail");

-- CreateIndex
CREATE INDEX "StyleCorrection_userId_contactEmail_idx" ON "StyleCorrection"("userId", "contactEmail");

-- CreateIndex
CREATE INDEX "StyleCorrection_userId_category_idx" ON "StyleCorrection"("userId", "category");

-- AddForeignKey
ALTER TABLE "WritingPreferences" ADD CONSTRAINT "WritingPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactStyle" ADD CONSTRAINT "ContactStyle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StyleCorrection" ADD CONSTRAINT "StyleCorrection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
