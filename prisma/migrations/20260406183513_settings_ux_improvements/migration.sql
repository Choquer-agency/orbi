-- AlterTable
ALTER TABLE "Signature" ADD COLUMN     "accountId" TEXT;

-- AlterTable
ALTER TABLE "TriageFeedback" ALTER COLUMN "emailId" DROP NOT NULL,
ALTER COLUMN "threadId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
