import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  KAMINO_LEND_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  displayMintFromConstraint,
  type AccountSlot,
  type CompanionInstruction,
  type DataSlot,
  type DataTemplate,
  type HookDetail,
  type HookFormField,
  type WireAccountSlot,
  type WireCompanionRequirement,
  type WireDataSlot,
  type WireMintConstraint,
} from '@pook/contract'
import type { HookDefinition } from '@pook/sdk'
import { assetMeta } from './accounts.js'

export type StoredDraftMetadata = {
  hookId: string
  author: string
  protocol: string
  protocolName: string
  label: string
  description: string
  instructionName: string
  discriminator: string | null
  dataTemplate: unknown
  accountsTemplate: unknown
  companionInstructions: unknown
  formFields: unknown
  assetInSymbol: string | null
  assetOutSymbol: string | null
}

export type OnChainHookTruth = {
  hookId: string
  kind: 'flow' | 'seat' | string
  targetProgram: string
  mintIn: WireMintConstraint
  mintOut: WireMintConstraint
  wrapSolIn: boolean
  unwrapSolOut: boolean
  dataTemplateHex: string
  dataSlots: readonly WireDataSlot[]
  accountSlots: readonly WireAccountSlot[]
  companions: readonly WireCompanionRequirement[]
  author: string
}

const SYSVAR_PREFIX = 'Sysvar'
const KNOWN_PROGRAMS = new Set([
  SYSTEM_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'Stake11111111111111111111111111111111111111',
  KAMINO_LEND_PROGRAM_ID,
])

function displayRoleForAccountSlot(slot: WireAccountSlot): AccountSlot['role'] {
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
    default:
      return 'caller_supplied'
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asDataTemplate(value: unknown): DataTemplate | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as { baseHex?: unknown; slots?: unknown }
  if (typeof obj.baseHex !== 'string' || !Array.isArray(obj.slots)) return null
  return { baseHex: obj.baseHex, slots: obj.slots as DataSlot[] }
}

/**
 * Joins on-chain Hook truth with optional launch metadata or stored publish-time draft metadata,
 * deriving readable account templates, data slots, companion entries, and form fields when no
 * off-chain metadata was supplied. On-chain fields always win over off-chain drafts.
 */
export function resolveHookDisplay(params: {
  onChain: OnChainHookTruth
  launchMeta?: HookDefinition | null
  draftMeta?: StoredDraftMetadata | null
}): {
  protocol: string
  protocolName: string
  label: string
  description: string
  instructionName: string
  discriminator: string
  mintIn: string | null
  mintOut: string | null
  assetInSymbol: string | null
  assetOutSymbol: string | null
  dataTemplate: DataTemplate
  accountsTemplate: AccountSlot[]
  companionInstructions: CompanionInstruction[]
  formFields: HookFormField[]
} {
  const { onChain, launchMeta, draftMeta } = params
  const id = onChain.hookId
  const firstSegment = id.split('.')[0] || 'custom'
  const secondSegment = id.split('.')[1] || 'execute'

  const mintIn = displayMintFromConstraint(onChain.mintIn)
  const mintOut = displayMintFromConstraint(onChain.mintOut)

  const protocol = launchMeta?.protocol ?? draftMeta?.protocol ?? firstSegment
  const protocolName =
    launchMeta?.protocolName ??
    draftMeta?.protocolName ??
    (firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1))
  const label = launchMeta?.label ?? draftMeta?.label ?? id
  const description = launchMeta?.description ?? draftMeta?.description ?? `On-chain hook ${id}`
  const instructionName = launchMeta?.instructionName ?? draftMeta?.instructionName ?? secondSegment
  const discriminator =
    (onChain.dataTemplateHex.length > 0
      ? onChain.dataTemplateHex.slice(0, Math.min(16, onChain.dataTemplateHex.length))
      : '') ||
    launchMeta?.discriminator ||
    draftMeta?.discriminator ||
    '00'

  const metaAccounts = launchMeta?.accountsTemplate ?? asArray<AccountSlot>(draftMeta?.accountsTemplate)
  const accountsTemplate: AccountSlot[] = onChain.accountSlots.map((slot, index) => {
    const hint = metaAccounts[index]
    const name = hint?.name?.trim() || `account ${index}`
    return {
      index,
      name,
      role: displayRoleForAccountSlot(slot),
      ...(slot.kind === 'Fixed' ? { address: slot.pubkey } : {}),
      writable: slot.isWritable,
      signer: slot.isSigner,
      ...(hint?.description ? { description: hint.description } : {}),
    }
  })

  const metaDataTemplate = launchMeta?.dataTemplate ?? asDataTemplate(draftMeta?.dataTemplate)
  const metaDataSlots = metaDataTemplate?.slots ?? []
  const dataSlots: DataSlot[] = onChain.dataSlots.map((slot, index) => {
    const hint = metaDataSlots[index]
    const kind: DataSlot['kind'] =
      slot.kind === 'AmountInU64Le' ? 'amount_in' : slot.kind === 'MinOutU64Le' ? 'min_out' : 'caller_arg'
    const type: DataSlot['type'] = slot.kind === 'CallerTail' || slot.len !== 8 ? 'bytes' : (hint?.type ?? 'u64')
    const defaultName =
      slot.kind === 'AmountInU64Le' ? 'amountIn' : slot.kind === 'MinOutU64Le' ? 'minimumOut' : `arg_${index}`
    const defaultLabel =
      slot.kind === 'AmountInU64Le' ? 'Amount in' : slot.kind === 'MinOutU64Le' ? 'Minimum out' : `Arg ${index}`
    return {
      name: hint?.name?.trim() || defaultName,
      kind,
      offset: slot.offset,
      length: slot.len,
      type,
      label: hint?.label?.trim() || defaultLabel,
      ...(hint?.description ? { description: hint.description } : {}),
    }
  })
  const dataTemplate: DataTemplate = {
    baseHex: onChain.dataTemplateHex,
    slots: dataSlots,
  }

  const metaCompanions = launchMeta?.companionInstructions ?? asArray<CompanionInstruction>(draftMeta?.companionInstructions)
  const companionInstructions: CompanionInstruction[] = onChain.companions.map((comp, index) => {
    const disc = comp.discriminatorHex.slice(0, comp.discLen * 2).toLowerCase()
    const hint = metaCompanions.find((c) => c.discriminator.toLowerCase() === disc) ?? metaCompanions[index]
    return {
      programId: comp.programId,
      instructionName: hint?.instructionName?.trim() || `companion_${index}`,
      discriminator: disc,
      position: comp.mustPrecede ? 'before' : 'after',
      ...(hint?.description ? { description: hint.description } : {}),
    }
  })

  const providedFormFields = launchMeta?.formFields?.length
    ? launchMeta.formFields
    : asArray<HookFormField>(draftMeta?.formFields)

  let formFields: HookFormField[]
  if (providedFormFields.length > 0) {
    formFields = providedFormFields
  } else {
    formFields = []
    if (onChain.kind === 'seat') {
      formFields.push({ name: 'seatAddress', kind: 'seat', label: 'Seat', required: false })
    }
    if (onChain.mintIn.kind === 'Any') {
      formFields.push({ name: 'mintIn', kind: 'asset_in', label: 'Asset in', required: true })
    }
    if (onChain.mintOut.kind === 'Any') {
      formFields.push({ name: 'mintOut', kind: 'asset_out', label: 'Asset out', required: true })
    }
    if (onChain.dataSlots.some((s) => s.kind === 'AmountInU64Le') || onChain.mintIn.kind !== 'None') {
      formFields.push({ name: 'amountIn', kind: 'amount', label: 'Amount', required: true })
    }
    onChain.accountSlots.forEach((slot, index) => {
      if (slot.kind === 'Caller') {
        const slotName = accountsTemplate[index]?.name ?? `account ${index}`
        formFields.push({ name: slotName, kind: 'text', label: slotName, required: true })
      }
    })
  }

  const assetInSymbol = launchMeta?.assetInSymbol ?? draftMeta?.assetInSymbol ?? assetMeta(mintIn)?.symbol ?? null
  const assetOutSymbol = launchMeta?.assetOutSymbol ?? draftMeta?.assetOutSymbol ?? assetMeta(mintOut)?.symbol ?? null

  return {
    protocol,
    protocolName,
    label,
    description,
    instructionName,
    discriminator,
    mintIn,
    mintOut,
    assetInSymbol,
    assetOutSymbol,
    dataTemplate,
    accountsTemplate,
    companionInstructions,
    formFields,
  }
}

/** Builds a full `HookDetail` from an on-chain account plus optional metadata (API fallback before indexing). */
export function buildOnChainHookDetail(params: {
  address: string
  onChain: OnChainHookTruth
  launchMeta?: HookDefinition | null
  draftMeta?: StoredDraftMetadata | null
  authorShareBps: number | null
}): HookDetail {
  const { address, onChain, launchMeta, draftMeta, authorShareBps } = params
  const resolved = resolveHookDisplay({ onChain, launchMeta, draftMeta })
  return {
    id: onChain.hookId,
    address,
    protocol: resolved.protocol,
    protocolName: resolved.protocolName,
    label: resolved.label,
    description: resolved.description,
    kind: onChain.kind,
    targetProgram: onChain.targetProgram,
    instructionName: resolved.instructionName,
    discriminator: resolved.discriminator,
    dataTemplate: resolved.dataTemplate,
    accountsTemplate: resolved.accountsTemplate,
    companionInstructions: resolved.companionInstructions,
    mintInConstraint: onChain.mintIn,
    mintOutConstraint: onChain.mintOut,
    wrapSolIn: onChain.wrapSolIn,
    unwrapSolOut: onChain.unwrapSolOut,
    dataTemplateHex: onChain.dataTemplateHex,
    dataSlots: [...onChain.dataSlots],
    accountSlots: [...onChain.accountSlots],
    companions: [...onChain.companions],
    formFields: resolved.formFields,
    mintIn: resolved.mintIn,
    mintOut: resolved.mintOut,
    assetInSymbol: resolved.assetInSymbol,
    assetOutSymbol: resolved.assetOutSymbol,
    author: onChain.author,
    authorShareBps,
    immutable: true,
    sdkCall: `pook.run("${onChain.hookId}", { amount })`,
    stats: { runsCount: 0, volumeIn: '0', volumeOut: '0', lastRunAt: null },
    publishedAt: new Date().toISOString(),
    publishSignature: '1'.repeat(64),
  }
}
