import { HookDraft, type HookDraftOutput } from '@pook/contract'

export type HookDefinition = HookDraftOutput & {
  /** Optional notes or TODOs for localnet/IDL confirmation. */
  notes?: readonly string[]
}

export type DefineHookInput = HookDraft & {
  notes?: readonly string[]
}

/**
 * Define and validate a Pook hook specification.
 * Pure and browser-safe: returns a normalized, immutable hook definition ready for simulation and publishing.
 */
export function defineHook(input: DefineHookInput): HookDefinition {
  const { notes, ...draft } = input
  const parsed = HookDraft.parse(draft)
  return Object.freeze({
    ...parsed,
    ...(notes?.length ? { notes: Object.freeze([...notes]) } : {}),
  })
}
