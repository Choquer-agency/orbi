-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('PROMISE', 'DEADLINE', 'CHANGE_REQUEST', 'ACTION_ITEM');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'AUTO_RESOLVED');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sourceEmailId" TEXT,
    "description" TEXT NOT NULL,
    "contactEmail" TEXT,
    "contactName" TEXT,
    "taskType" "TaskType" NOT NULL DEFAULT 'ACTION_ITEM',
    "deadline" TIMESTAMP(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_userId_status_deadline_idx" ON "Task"("userId", "status", "deadline");

-- CreateIndex
CREATE INDEX "Task_threadId_idx" ON "Task"("threadId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
