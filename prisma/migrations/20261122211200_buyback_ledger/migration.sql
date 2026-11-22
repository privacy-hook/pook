-- CreateTable
CREATE TABLE "buyback_fee" (
    "mint" VARCHAR(44) NOT NULL,
    "accrued" TEXT NOT NULL DEFAULT '0',
    "spent" TEXT NOT NULL DEFAULT '0',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "buyback_fee_pkey" PRIMARY KEY ("mint")
);

-- CreateTable
CREATE TABLE "buyback_swap" (
    "key" TEXT NOT NULL,
    "mint" VARCHAR(44) NOT NULL,
    "amount_in" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "swap_signature" VARCHAR(88),
    "pook_delivered" TEXT,
    "burn_signature" VARCHAR(88),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "buyback_swap_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "buyback_swap_status_idx" ON "buyback_swap"("status");
