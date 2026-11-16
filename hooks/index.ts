import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SYSTEM_PROGRAM_ID,
  displayMintFromConstraint,
  type WireAccountSlot,
  type WireCompanionRequirement,
  type WireDataSlot,
  type WireMintConstraint,
} from '@pook/contract'
import { defineHook, type HookDefinition } from '@pook/sdk'
import { JITO_HOOK_META } from './jito.js'
import { JUPITER_HOOK_META, type LaunchHookDisplayMeta } from './jupiter.js'
import { KAMINO_HOOK_META } from './kamino.js'

export type { LaunchHookDisplayMeta }
export { JUPITER_HOOK_META, JITO_HOOK_META, KAMINO_HOOK_META }

/** Canonical launch hook order. Every on-chain field is read from `program/hooks/<id>.json`. */
export const LAUNCH_HOOK_IDS = [
  'jupiter.swap',
  'kamino.supply',
  'kamino.withdraw',
  'jito.stake',
  'jito.unstake',
  'kamino.collateral.deposit',
  'kamino.borrow',
  'kamino.repay',
  'kamino.collateral.withdraw',
] as const

/** Off-chain display metadata only, keyed by hook id. */
export const LAUNCH_HOOK_DISPLAY_META: Record<string, LaunchHookDisplayMeta> = {
  ...JUPITER_HOOK_META,
  ...KAMINO_HOOK_META,
  ...JITO_HOOK_META,
}

type JsonMintConstraint = {
  type?: 'None' | 'Any' | 'Sol' | 'Spl'
  kind?: 'None' | 'Any' | 'Sol' | 'Spl'
  mint?: string
}

type ProgramHookJson = {
  hook_id: string
  target_program: string
  kind: 'Flow' | 'Seat' | 'flow' | 'seat'
  mint_in: JsonMintConstraint
  mint_out: JsonMintConstraint
  wrap_sol_in: boolean
  unwrap_sol_out: boolean
  data_template: number[] | string
  data_slots: { offset: number; len: number; kind: WireDataSlot['kind'] }[]
  account_slots: {
    kind: WireAccountSlot['kind']
    is_writable: boolean
    is_signer: boolean
    pubkey?: string
  }[]
  companions: {
    program_id: string
    discriminator: number[] | string
    disc_len: number
    must_precede: boolean
  }[]
}

const SYSVAR_PREFIX = 'Sysvar'
const KNOWN_PROGRAMS = new Set([
  SYSTEM_PROGRAM_ID,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'Stake11111111111111111111111111111111111111',
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
])

function bytesToHex(val: number[] | string): string {
  return typeof val === 'string' ? val : Buffer.from(val).toString('hex')
}

function parseMintConstraint(raw: JsonMintConstraint): WireMintConstraint {
  const tag = raw.type ?? raw.kind
  if (tag === 'Spl' && raw.mint) return { kind: 'Spl', mint: raw.mint }
  if (tag === 'Sol') return { kind: 'Sol' }
  if (tag === 'None') return { kind: 'None' }
  return { kind: 'Any' }
}

function displayRoleForSlot(slot: WireAccountSlot): 'fixed' | 'stage_authority' | 'stage_in' | 'stage_out' | 'seat_pda' | 'caller_supplied' | 'program' | 'sysvar' | 'payer' {
  switch (slot.kind) {
    case 'StagePda':
      return 'stage_authority'
    case 'StageIn':
      return 'stage_in'
    case 'StageOut':
      return 'stage_out'
    case 'SeatPda':
      return 'seat_pda'
    case 'Payer':
      return 'payer'
    case 'Caller':
    case 'CallerRemaining':
      return 'caller_supplied'
    case 'Fixed':
      if (slot.pubkey.startsWith(SYSVAR_PREFIX)) return 'sysvar'
      if (KNOWN_PROGRAMS.has(slot.pubkey)) return 'program'
      return 'fixed'
  }
}

function resolveProgramHooksDir(explicitDir?: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    explicitDir,
    path.resolve(here, '../program/hooks'),
    path.resolve(here, '../../program/hooks'),
  ].filter((d): d is string => Boolean(d))
  const found = candidates.find((d) => existsSync(d))
  if (!found) {
    throw new Error(`Could not locate canonical launch hook JSON directory (checked: ${candidates.join(', ')})`)
  }
  return found
}

function hookFromJson(raw: ProgramHookJson, meta: LaunchHookDisplayMeta): HookDefinition {
  const kind: 'flow' | 'seat' = raw.kind.toLowerCase() === 'seat' ? 'seat' : 'flow'
  const mintInConstraint = parseMintConstraint(raw.mint_in)
  const mintOutConstraint = parseMintConstraint(raw.mint_out)
  const dataTemplateHex = bytesToHex(raw.data_template)
  const discriminator =
    dataTemplateHex.length > 0
      ? dataTemplateHex.slice(0, Math.min(16, dataTemplateHex.length))
      : (meta.discriminatorFallback ?? '')

  const dataSlots: WireDataSlot[] = raw.data_slots.map((s) => ({
    offset: s.offset,
    len: s.len,
    kind: s.kind,
  }))

  const accountSlots: WireAccountSlot[] = raw.account_slots.map((s) => ({
    kind: s.kind,
    isWritable: Boolean(s.is_writable),
    isSigner: Boolean(s.is_signer),
    pubkey: s.pubkey ?? SYSTEM_PROGRAM_ID,
  }))

  const companions: WireCompanionRequirement[] = raw.companions.map((c) => {
    const discHex = bytesToHex(c.discriminator)
    return {
      programId: c.program_id,
      discriminatorHex: discHex,
      discLen: c.disc_len,
      mustPrecede: Boolean(c.must_precede),
    }
  })

  return defineHook({
    id: raw.hook_id,
    protocol: meta.protocol,
    protocolName: meta.protocolName,
    label: meta.label,
    description: meta.description,
    kind,
    targetProgram: raw.target_program,
    instructionName: meta.instructionName,
    discriminator,
    mintInConstraint,
    mintOutConstraint,
    wrapSolIn: Boolean(raw.wrap_sol_in),
    unwrapSolOut: Boolean(raw.unwrap_sol_out),
    dataTemplateHex,
    dataSlots,
    accountSlots,
    companions,
    dataTemplate: {
      baseHex: dataTemplateHex,
      slots: dataSlots.map((s, idx) => {
        const labelMeta = meta.dataSlotLabels?.[idx]
        const slotKind: 'amount_in' | 'min_out' | 'caller_arg' =
          s.kind === 'AmountInU64Le' ? 'amount_in' : s.kind === 'MinOutU64Le' ? 'min_out' : 'caller_arg'
        const slotType: 'u64' | 'bytes' = s.kind === 'CallerTail' || s.len !== 8 ? 'bytes' : 'u64'
        return {
          name: labelMeta?.name ?? `slot_${idx}`,
          kind: slotKind,
          offset: s.offset,
          length: s.len,
          type: slotType,
          ...(labelMeta?.label ? { label: labelMeta.label } : {}),
        }
      }),
    },
    accountsTemplate: accountSlots.map((slot, index) => ({
      index,
      name: meta.accountNames?.[index] ?? `account_${index}`,
      role: displayRoleForSlot(slot),
      ...(slot.kind === 'Fixed' ? { address: slot.pubkey } : {}),
      writable: slot.isWritable,
      signer: slot.isSigner,
    })),
    companionInstructions: companions.map((comp) => {
      const disc = comp.discriminatorHex.slice(0, comp.discLen * 2).toLowerCase()
      const cMeta = meta.companionMeta?.[disc]
      return {
        programId: comp.programId,
        instructionName: cMeta?.instructionName ?? 'companion',
        discriminator: disc,
        position: comp.mustPrecede ? 'before' : 'after',
        ...(cMeta?.description ? { description: cMeta.description } : {}),
      }
    }),
    formFields: meta.formFields,
    mintIn: displayMintFromConstraint(mintInConstraint),
    mintOut: displayMintFromConstraint(mintOutConstraint),
    assetInSymbol: meta.assetInSymbol,
    assetOutSymbol: meta.assetOutSymbol,
  })
}

/**
 * Loads all nine launch hooks from canonical `program/hooks/<id>.json` files
 * and joins off-chain display metadata from `LAUNCH_HOOK_DISPLAY_META`.
 */
export function loadLaunchHooks(programHooksDir?: string): readonly HookDefinition[] {
  const dir = resolveProgramHooksDir(programHooksDir)
  return LAUNCH_HOOK_IDS.map((id) => {
    const filePath = path.join(dir, `${id}.json`)
    if (!existsSync(filePath)) {
      throw new Error(`Missing canonical launch hook JSON file: ${filePath}`)
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as ProgramHookJson
    const meta = LAUNCH_HOOK_DISPLAY_META[id]!
    return hookFromJson(raw, meta)
  })
}

export const LAUNCH_HOOK_DEFINITIONS: readonly HookDefinition[] = loadLaunchHooks()
export const LAUNCH_HOOK_METADATA = new Map<string, HookDefinition>(
  LAUNCH_HOOK_DEFINITIONS.map((h) => [h.id, h]),
)
