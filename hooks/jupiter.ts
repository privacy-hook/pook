import type { HookDraft } from '@pook/contract'

/** Off-chain display metadata for a launch hook; every on-chain field comes from program/hooks/<id>.json. */
export type LaunchHookDisplayMeta = {
  id: string
  protocol: string
  protocolName: string
  label: string
  description: string
  instructionName: string
  /** Display-only discriminator when on-chain data_template is empty (e.g. CallerTail hooks). */
  discriminatorFallback?: string
  assetInSymbol: string | null
  assetOutSymbol: string | null
  formFields: NonNullable<HookDraft['formFields']>
  accountNames?: Record<number, string>
  dataSlotLabels?: Record<number, { name: string; label: string }>
  companionMeta?: Record<string, { instructionName: string; description: string }>
}

export const JUPITER_HOOK_META: Record<string, LaunchHookDisplayMeta> = {
  'jupiter.swap': {
    id: 'jupiter.swap',
    protocol: 'jupiter',
    protocolName: 'Jupiter',
    label: 'Swap',
    description: 'One asset in, another out, at Jupiter’s route.',
    instructionName: 'route_v2',
    discriminatorFallback: 'bb64facc31c4af14',
    assetInSymbol: null,
    assetOutSymbol: null,
    formFields: [
      { name: 'mintIn', kind: 'asset_in', label: 'Asset in', required: true },
      { name: 'mintOut', kind: 'asset_out', label: 'Asset out', required: true },
      { name: 'amountIn', kind: 'amount', label: 'Amount', required: true, placeholder: '100' },
      { name: 'slippageBps', kind: 'slippage_bps', label: 'Slippage (bps)', required: false, defaultValue: '50' },
    ],
    accountNames: {
      0: 'tokenProgram',
      1: 'userTransferAuthority',
      2: 'userSourceTokenAccount',
      3: 'userDestinationTokenAccount',
      4: 'routeAccounts',
    },
    dataSlotLabels: {
      0: { name: 'routeData', label: 'Jupiter route instruction payload' },
    },
  },
}
