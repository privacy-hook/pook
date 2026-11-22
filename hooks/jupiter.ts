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

export const JUPITER_LEND_HOOK_META: Record<string, LaunchHookDisplayMeta> = {
  'jupiter.lend.supply': {
    id: 'jupiter.lend.supply',
    protocol: 'jupiter-lend',
    protocolName: 'Jupiter Lend',
    label: 'Supply',
    description: 'An asset in, its Jupiter Lend earn token out.',
    instructionName: 'deposit_with_min_amount_out',
    assetInSymbol: null,
    assetOutSymbol: null,
    formFields: [
      { name: 'mintIn', kind: 'asset_in', label: 'Asset to supply', required: true },
      { name: 'amountIn', kind: 'amount', label: 'Amount', required: true, placeholder: '500' },
      { name: 'slippageBps', kind: 'slippage_bps', label: 'Slippage (bps)', required: false, defaultValue: '50' },
    ],
    accountNames: {
      0: 'signer',
      1: 'depositorTokenAccount',
      2: 'recipientTokenAccount',
      3: 'mint',
      4: 'lendingAdmin',
      5: 'lending',
      6: 'fTokenMint',
      7: 'supplyTokenReservesLiquidity',
      8: 'lendingSupplyPositionOnLiquidity',
      9: 'rateModel',
      10: 'vault',
      11: 'liquidity',
      12: 'liquidityProgram',
      13: 'rewardsRateModel',
      14: 'tokenProgram',
      15: 'associatedTokenProgram',
      16: 'systemProgram',
    },
    dataSlotLabels: {
      0: { name: 'assets', label: 'Assets' },
      1: { name: 'minAmountOut', label: 'Minimum earn tokens out' },
    },
  },
  'jupiter.lend.withdraw': {
    id: 'jupiter.lend.withdraw',
    protocol: 'jupiter-lend',
    protocolName: 'Jupiter Lend',
    label: 'Withdraw',
    description: 'A Jupiter Lend earn token in, the asset out.',
    instructionName: 'redeem_with_min_amount_out',
    assetInSymbol: null,
    assetOutSymbol: null,
    formFields: [
      { name: 'mintIn', kind: 'asset_in', label: 'Earn token', required: true },
      { name: 'amountIn', kind: 'amount', label: 'Amount', required: true, placeholder: '250' },
      { name: 'slippageBps', kind: 'slippage_bps', label: 'Slippage (bps)', required: false, defaultValue: '50' },
    ],
    accountNames: {
      0: 'signer',
      1: 'ownerTokenAccount',
      2: 'recipientTokenAccount',
      3: 'lendingAdmin',
      4: 'lending',
      5: 'mint',
      6: 'fTokenMint',
      7: 'supplyTokenReservesLiquidity',
      8: 'lendingSupplyPositionOnLiquidity',
      9: 'rateModel',
      10: 'vault',
      11: 'claimAccount',
      12: 'liquidity',
      13: 'liquidityProgram',
      14: 'rewardsRateModel',
      15: 'tokenProgram',
      16: 'associatedTokenProgram',
      17: 'systemProgram',
    },
    dataSlotLabels: {
      0: { name: 'shares', label: 'Earn tokens' },
      1: { name: 'minAmountOut', label: 'Minimum asset out' },
    },
  },
}
