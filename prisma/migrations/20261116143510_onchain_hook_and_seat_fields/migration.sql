-- AlterTable
ALTER TABLE "hooks" ADD COLUMN     "account_slots" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "companions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "data_slots" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "data_template_hex" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "hook_id_hash" VARCHAR(64) NOT NULL DEFAULT '',
ADD COLUMN     "mint_in_constraint" JSONB NOT NULL DEFAULT '{"kind":"Any"}',
ADD COLUMN     "mint_out_constraint" JSONB NOT NULL DEFAULT '{"kind":"Any"}',
ADD COLUMN     "unwrap_sol_out" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wrap_sol_in" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "seats" ADD COLUMN     "commitment" VARCHAR(64),
ADD COLUMN     "opener_relayer" VARCHAR(44);

-- CreateIndex
CREATE UNIQUE INDEX "seats_commitment_key" ON "seats"("commitment");
