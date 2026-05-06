-- CreateIndex
CREATE INDEX "Email_accountId_fromAddress_idx" ON "Email"("accountId", "fromAddress");

-- CreateIndex
CREATE INDEX "Email_accountId_fromName_idx" ON "Email"("accountId", "fromName");
