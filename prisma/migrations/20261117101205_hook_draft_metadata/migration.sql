-- CreateTable
CREATE TABLE "hook_draft_metadata" (
    "hook_id" VARCHAR(64) NOT NULL,
    "author" VARCHAR(44) NOT NULL,
    "protocol" VARCHAR(32) NOT NULL,
    "protocol_name" VARCHAR(64) NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "description" TEXT NOT NULL,
    "instruction_name" VARCHAR(64) NOT NULL,
    "discriminator" VARCHAR(512),
    "data_template" JSONB NOT NULL,
    "accounts_template" JSONB NOT NULL,
    "companion_instructions" JSONB NOT NULL DEFAULT '[]',
    "form_fields" JSONB NOT NULL DEFAULT '[]',
    "asset_in_symbol" VARCHAR(24),
    "asset_out_symbol" VARCHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hook_draft_metadata_pkey" PRIMARY KEY ("hook_id")
);
