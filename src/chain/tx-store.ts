import type { PrismaClient } from '@prisma/client'
import type { TxRecord, TxStore } from '../engines/tx/server/ledger.js'

type StoredTx = TxRecord & { action?: string }

/**
 * Prisma-backed TxStore over `WalletTransaction` for `engines/tx/server/ledger.ts`.
 * Keeps transient relay bytes & submission keys in-memory alongside durable Postgres state
 * so restarts still read the signature, status, blockhash, and errors cleanly.
 */
export class PrismaWalletTxStore implements TxStore {
  private readonly transient = new Map<string, { signedBase64?: string; submissionKey?: string; contextSlot?: number; action?: string }>()

  constructor(private readonly db: PrismaClient) {}

  async createBuild(input: {
    id: string
    action: string
    wallet: string
    transactionBase64: string
    blockhash: string
    lastValidBlockHeight: number
    contextSlot: number
    expiresAt: Date
  }) {
    this.transient.set(input.id, { contextSlot: input.contextSlot, action: input.action })
    await this.db.walletTransaction.create({
      data: {
        id: input.id,
        action: input.action,
        wallet: input.wallet,
        status: 'built',
        transactionBase64: input.transactionBase64,
        blockhash: input.blockhash,
        lastValidBlockHeight: BigInt(input.lastValidBlockHeight),
        expiresAt: input.expiresAt,
      },
    })
  }

  async getByIdOrSignature(idOrSig: string) {
    return this.db.walletTransaction.findFirst({
      where: { OR: [{ id: idOrSig }, { signature: idOrSig }] },
    })
  }

  async get(id: string): Promise<StoredTx | null> {
    const row = await this.getByIdOrSignature(id)
    if (!row) return null
    const extra = this.transient.get(row.id)
    return {
      id: row.id,
      action: row.action,
      wallet: row.wallet,
      transactionBase64: row.transactionBase64,
      blockhash: row.blockhash,
      lastValidBlockHeight: Number(row.lastValidBlockHeight),
      cosigned: false,
      contextSlot: extra?.contextSlot,
      status: row.status as TxRecord['status'],
      signature: row.signature ?? undefined,
      signedBase64: extra?.signedBase64,
      submissionKey: extra?.submissionKey,
      error: row.errorMessage
        ? {
            stage: (row.errorStage as 'build' | 'simulation' | 'send' | 'confirm' | 'wallet-changed') ?? 'confirm',
            message: row.errorMessage,
            retryable: row.status === 'expired',
            program: row.programError
              ? (() => {
                  const pe = row.programError as { programId?: string; number?: number; name?: string }
                  return {
                    address: pe.programId ?? '',
                    code: pe.number ?? null,
                    name: pe.name ?? null,
                  }
                })()
              : undefined,
          }
        : undefined,
    }
  }

  async claim(id: string, patch: Partial<TxRecord>): Promise<boolean> {
    const res = await this.db.walletTransaction.updateMany({
      where: { id, status: 'built' },
      data: {
        status: patch.status ?? 'submitted',
        signature: patch.signature ?? null,
      },
    })
    if (res.count === 1) {
      const prev = this.transient.get(id) ?? {}
      this.transient.set(id, {
        ...prev,
        ...(patch.signedBase64 ? { signedBase64: patch.signedBase64 } : {}),
        ...(patch.submissionKey ? { submissionKey: patch.submissionKey } : {}),
      })
      return true
    }
    return false
  }

  async update(id: string, patch: Partial<TxRecord>): Promise<void> {
    const row = await this.getByIdOrSignature(id)
    if (!row) return
    await this.db.walletTransaction.update({
      where: { id: row.id },
      data: {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.signature !== undefined ? { signature: patch.signature ?? null } : {}),
        ...(patch.error
          ? {
              errorCode: patch.error.program?.name ?? 'CHAIN_REFUSED',
              errorMessage: patch.error.message,
              errorStage: patch.error.stage,
              programError: patch.error.program
                ? {
                    programId: patch.error.program.address,
                    name: patch.error.program.name ?? 'UnknownProgramError',
                    number: patch.error.program.code ?? 0,
                  }
                : undefined,
            }
          : {}),
      },
    })
  }
}
