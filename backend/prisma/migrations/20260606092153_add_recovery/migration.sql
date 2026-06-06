-- AlterTable
ALTER TABLE "User" ADD COLUMN     "encryptedVaultKey" TEXT,
ADD COLUMN     "encryptedVaultKeyIv" TEXT;
