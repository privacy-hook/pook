-- CreateTable
CREATE TABLE "ServiceReadiness" (
    "id" TEXT NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "nextProbeAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,

    CONSTRAINT "ServiceReadiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexed_transactions" (
    "signature" VARCHAR(88) NOT NULL,
    "slot" BIGINT NOT NULL,
    "transaction_index" INTEGER NOT NULL DEFAULT 0,
    "block_time" TIMESTAMPTZ(6),
    "failed" BOOLEAN NOT NULL,
    "addresses" TEXT[],
    "facts" JSONB,
    "decode_error" TEXT,
    "chain_error" JSONB,
    "applied_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexed_transactions_pkey" PRIMARY KEY ("signature")
);

-- CreateTable
CREATE TABLE "indexer_cursors" (
    "address" VARCHAR(44) NOT NULL,
    "latest_signature" VARCHAR(88),
    "latest_slot" BIGINT,
    "discovered_by" VARCHAR(88),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexer_cursors_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "worker_leases" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_leases_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "KeeperTransaction" (
    "key" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signedBase64" TEXT NOT NULL,
    "blockhash" TEXT NOT NULL,
    "lastValidBlockHeight" BIGINT NOT NULL,
    "contextSlot" BIGINT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "KeeperTransaction_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "protocol_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "program_id" VARCHAR(44),
    "authority_pda" VARCHAR(44),
    "run_fee_bps" INTEGER,
    "author_share_bps" INTEGER,
    "fee_recipient" VARCHAR(44),
    "admin" VARCHAR(44),
    "updated_slot" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hooks" (
    "id" VARCHAR(64) NOT NULL,
    "address" VARCHAR(44) NOT NULL,
    "protocol" VARCHAR(32) NOT NULL,
    "protocol_name" VARCHAR(64) NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "description" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "target_program" VARCHAR(44) NOT NULL,
    "instruction_name" VARCHAR(64) NOT NULL,
    "discriminator" VARCHAR(32) NOT NULL,
    "data_template" JSONB NOT NULL,
    "accounts_template" JSONB NOT NULL,
    "companion_instructions" JSONB NOT NULL DEFAULT '[]',
    "form_fields" JSONB NOT NULL DEFAULT '[]',
    "mint_in" VARCHAR(44),
    "mint_out" VARCHAR(44),
    "asset_in_symbol" VARCHAR(24),
    "asset_out_symbol" VARCHAR(24),
    "author" VARCHAR(44) NOT NULL,
    "immutable" BOOLEAN NOT NULL DEFAULT true,
    "runs_count" INTEGER NOT NULL DEFAULT 0,
    "volume_in" TEXT NOT NULL DEFAULT '0',
    "volume_out" TEXT NOT NULL DEFAULT '0',
    "last_run_at" TIMESTAMPTZ(3),
    "publish_signature" VARCHAR(88) NOT NULL,
    "published_slot" BIGINT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "hooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hook_runs" (
    "signature" VARCHAR(88) NOT NULL,
    "slot" BIGINT NOT NULL,
    "hook_id" VARCHAR(64) NOT NULL,
    "hook_address" VARCHAR(44) NOT NULL,
    "protocol" VARCHAR(32) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "mint_in" VARCHAR(44),
    "asset_in_symbol" VARCHAR(24),
    "amount_in" TEXT NOT NULL,
    "mint_out" VARCHAR(44),
    "asset_out_symbol" VARCHAR(24),
    "amount_out" TEXT NOT NULL,
    "run_fee_amount" TEXT NOT NULL DEFAULT '0',
    "author_fee_amount" TEXT NOT NULL DEFAULT '0',
    "protocol_fee_amount" TEXT NOT NULL DEFAULT '0',
    "relayer_fee_amount" TEXT NOT NULL DEFAULT '0',
    "stage_authority" VARCHAR(44) NOT NULL,
    "relayer" VARCHAR(44) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "block_time" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hook_runs_pkey" PRIMARY KEY ("signature")
);

-- CreateTable
CREATE TABLE "seats" (
    "address" VARCHAR(44) NOT NULL,
    "protocol" VARCHAR(32) NOT NULL,
    "obligation_address" VARCHAR(44),
    "status" VARCHAR(16) NOT NULL,
    "opened_signature" VARCHAR(88) NOT NULL,
    "opened_slot" BIGINT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_signature" VARCHAR(88),
    "closed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "seats_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "author_fee_ledger" (
    "id" TEXT NOT NULL,
    "author" VARCHAR(44) NOT NULL,
    "hook_id" VARCHAR(64) NOT NULL,
    "hook_address" VARCHAR(44) NOT NULL,
    "mint" VARCHAR(44) NOT NULL,
    "asset_symbol" VARCHAR(24),
    "decimals" INTEGER NOT NULL,
    "claimable_amount" TEXT NOT NULL DEFAULT '0',
    "total_earned_amount" TEXT NOT NULL DEFAULT '0',
    "last_claimed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "author_fee_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_jobs" (
    "id" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "hook_id" VARCHAR(64),
    "status" VARCHAR(16) NOT NULL,
    "signature" VARCHAR(88),
    "slot" BIGINT,
    "mint_in" VARCHAR(44),
    "mint_out" VARCHAR(44),
    "amount_in" TEXT NOT NULL,
    "minimum_out" TEXT NOT NULL,
    "relayer_fee" TEXT NOT NULL,
    "expiry_unix_ts" BIGINT NOT NULL,
    "error_code" VARCHAR(48),
    "error_message" TEXT,
    "error_stage" VARCHAR(32),
    "program_error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "relay_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "signature" VARCHAR(88),
    "transaction_base64" TEXT NOT NULL,
    "blockhash" VARCHAR(64) NOT NULL,
    "last_valid_block_height" BIGINT NOT NULL,
    "error_code" VARCHAR(48),
    "error_message" TEXT,
    "error_stage" VARCHAR(32),
    "program_error" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "indexed_transactions_applied_at_slot_transaction_index_idx" ON "indexed_transactions"("applied_at", "slot", "transaction_index");

-- CreateIndex
CREATE UNIQUE INDEX "KeeperTransaction_signature_key" ON "KeeperTransaction"("signature");

-- CreateIndex
CREATE INDEX "KeeperTransaction_state_createdAt_idx" ON "KeeperTransaction"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "hooks_address_key" ON "hooks"("address");

-- CreateIndex
CREATE INDEX "hooks_protocol_idx" ON "hooks"("protocol");

-- CreateIndex
CREATE INDEX "hooks_author_idx" ON "hooks"("author");

-- CreateIndex
CREATE INDEX "hook_runs_block_time_idx" ON "hook_runs"("block_time" DESC);

-- CreateIndex
CREATE INDEX "hook_runs_hook_id_block_time_idx" ON "hook_runs"("hook_id", "block_time" DESC);

-- CreateIndex
CREATE INDEX "hook_runs_protocol_block_time_idx" ON "hook_runs"("protocol", "block_time" DESC);

-- CreateIndex
CREATE INDEX "seats_protocol_status_idx" ON "seats"("protocol", "status");

-- CreateIndex
CREATE INDEX "author_fee_ledger_author_idx" ON "author_fee_ledger"("author");

-- CreateIndex
CREATE UNIQUE INDEX "author_fee_ledger_author_hook_id_mint_key" ON "author_fee_ledger"("author", "hook_id", "mint");

-- CreateIndex
CREATE UNIQUE INDEX "relay_jobs_signature_key" ON "relay_jobs"("signature");

-- CreateIndex
CREATE INDEX "relay_jobs_status_created_at_idx" ON "relay_jobs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_signature_key" ON "wallet_transactions"("signature");

-- CreateIndex
CREATE INDEX "wallet_transactions_wallet_created_at_idx" ON "wallet_transactions"("wallet", "created_at");

-- AddForeignKey
ALTER TABLE "hook_runs" ADD CONSTRAINT "hook_runs_hook_id_fkey" FOREIGN KEY ("hook_id") REFERENCES "hooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "author_fee_ledger" ADD CONSTRAINT "author_fee_ledger_hook_id_fkey" FOREIGN KEY ("hook_id") REFERENCES "hooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
