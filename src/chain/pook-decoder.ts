import {
  NATIVE_SOL_MINT,
  POOK_TAGS,
  WSOL_MINT,
  decodeClaimAuthorFeesIxData,
  decodeLeaveIxData,
  decodePublishHookIxData,
  decodeRunIxData,
  decodeSeatLifecycleIxData,
  toBase58,
  toHex,
} from '@pook/contract'
import type { ProgramDecoder } from '../engines/indexer/decoder.js'
import type { Fields } from '../engines/indexer/fields.js'

function mintBytesToDisplay(mint: Uint8Array): string {
  const b58 = toBase58(mint)
  return b58 === NATIVE_SOL_MINT ? WSOL_MINT : b58
}

/**
 * Custom `ProgramDecoder` for `pook` (pinocchio native program with 1-byte instruction tags `0..8`).
 * Decodes directly from raw instruction bytes; never parses log lines.
 */
export function pookProgramDecoder(programId: string): ProgramDecoder {
  return {
    programId,
    instruction(data: Uint8Array): { name: string; args: Fields; accounts: string[] } | null {
      if (!data.length) return null
      const tag = data[0]!
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      switch (tag) {
        case POOK_TAGS.INIT_CONFIG: {
          if (data.length < 37) return null
          const feeRecipient = toBase58(data.subarray(1, 33))
          const runFeeBps = view.getUint16(33, true)
          const authorShareBps = view.getUint16(35, true)
          return {
            name: 'init_config',
            args: { runFeeBps, authorShareBps, feeRecipient },
            accounts: ['admin', 'configPda', 'systemProgram'],
          }
        }
        case POOK_TAGS.SET_CONFIG: {
          if (data.length < 69) return null
          const admin = toBase58(data.subarray(1, 33))
          const feeRecipient = toBase58(data.subarray(33, 65))
          const runFeeBps = view.getUint16(65, true)
          const authorShareBps = view.getUint16(67, true)
          return {
            name: 'set_config',
            args: { admin, feeRecipient, runFeeBps, authorShareBps },
            accounts: ['admin', 'configPda'],
          }
        }
        case POOK_TAGS.PUBLISH_HOOK: {
          const args = decodePublishHookIxData(data)
          return {
            name: 'publish_hook',
            args: {
              hookId: args.hookId,
              targetProgram: args.targetProgram,
              kind: args.kind,
              mintIn: JSON.stringify(args.mintIn),
              mintOut: JSON.stringify(args.mintOut),
              wrapSolIn: args.wrapSolIn,
              unwrapSolOut: args.unwrapSolOut,
              dataTemplateHex: args.dataTemplateHex,
              dataSlots: JSON.stringify(args.dataSlots),
              accountSlots: JSON.stringify(args.accountSlots),
              companions: JSON.stringify(args.companions),
            },
            accounts: ['author', 'hookPda', 'systemProgram'],
          }
        }
        case POOK_TAGS.ENTER: {
          const mode = data[1] ?? 0
          return {
            name: 'enter',
            args: { mode },
            accounts: ['depositor', 'tree', 'ringsProgram'],
          }
        }
        case POOK_TAGS.RUN: {
          const { args } = decodeRunIxData(data)
          return {
            name: 'run',
            args: {
              kind: args.kind,
              amountIn: args.amountIn.toString(),
              minOut: args.minOut.toString(),
              relayerFee: args.relayerFee.toString(),
              expiry: args.expiry.toString(),
              hasMintOut: args.hasMintOut,
              mintIn: mintBytesToDisplay(args.mintIn),
              mintOut: args.hasMintOut ? mintBytesToDisplay(args.mintOut) : null,
            },
            accounts: [
              'relayerPayer',
              'configPda',
              'hookPda',
              'authorityPda',
              'stagePda',
              'targetProgram',
              'ringsProgram',
              'systemProgram',
              'instructionsSysvar',
              'feeRecipient',
              'authorFeesPda',
            ],
          }
        }
        case POOK_TAGS.LEAVE: {
          const { args } = decodeLeaveIxData(data)
          return {
            name: 'leave',
            args: {
              amount: args.amount.toString(),
              relayerFee: args.relayerFee.toString(),
              expiry: args.expiry.toString(),
              mint: mintBytesToDisplay(args.mint),
              leaveKind: args.leaveKind,
            },
            accounts: ['relayerPayer', 'authorityPda', 'stagePda', 'ringsProgram', 'systemProgram', 'destination'],
          }
        }
        case POOK_TAGS.OPEN_SEAT: {
          const { args } = decodeSeatLifecycleIxData(data)
          return {
            name: 'open_seat',
            args: {
              commitmentHex: toHex(args.seatCommitment),
              expiry: args.expiry.toString(),
            },
            accounts: ['relayerPayer', 'seatStatePda', 'seatPda', 'systemProgram'],
          }
        }
        case POOK_TAGS.CLOSE_SEAT: {
          const { args } = decodeSeatLifecycleIxData(data)
          return {
            name: 'close_seat',
            args: {
              commitmentHex: toHex(args.seatCommitment),
              expiry: args.expiry.toString(),
            },
            accounts: ['relayerPayer', 'seatStatePda', 'seatPda', 'openerRelayer'],
          }
        }
        case POOK_TAGS.CLAIM_AUTHOR_FEES: {
          const args = decodeClaimAuthorFeesIxData(data)
          return {
            name: 'claim_author_fees',
            args: {
              mint: args.mint === NATIVE_SOL_MINT ? 'SOL' : args.mint,
            },
            accounts: ['author', 'authorFeesPda'],
          }
        }
        default:
          return null
      }
    },
  }
}
