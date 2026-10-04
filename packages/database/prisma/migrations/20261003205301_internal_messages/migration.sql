-- AlterEnum
ALTER TYPE "Direction" ADD VALUE 'INTERNAL';

-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'NOTE';

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "status" DROP NOT NULL;
