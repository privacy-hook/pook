// The zod building blocks every contract shares: keys, signatures, integer amounts, times, pages.
// Request schemas stay strict (z.strictObject); response schemas tolerate unknown keys (z.object)
// and unknown enum values (openEnum) so additive backend changes never break a deployed frontend.

import { z } from 'zod'
import { fromBase58 } from './encoding.js'

export const U64_MAX = 18446744073709551615n

const encodes = (bytes: number) => (value: string) => {
  try {
    return fromBase58(value).length === bytes
  } catch {
    return false
  }
}

export const Address = z.string().min(32).max(44).refine(encodes(32), 'Must be a base58 address of 32 bytes.')
export const Signature = z.string().min(64).max(88).refine(encodes(64), 'Must be a base58 signature of 64 bytes.')

/** Unsigned integer base units as a decimal string. Arithmetic happens in BigInt, never Number. */
export const BaseUnits = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/, 'Must be an unsigned integer string.')
export const U64 = BaseUnits.refine((v) => BigInt(v) <= U64_MAX, 'Must fit an unsigned 64-bit integer.')
export const PositiveU64 = U64.refine((v) => v !== '0', 'Must be greater than zero.')

export const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Must be base64.')
export const Hex = z.string().regex(/^([0-9a-fA-F]{2})*$/, 'Must be even-length hex bytes.')
export const Timestamp = z.iso.datetime()

/** Hook slug, e.g. "jupiter.swap", "kamino.collateral.deposit" (at most 48 UTF-8 bytes, matching on-chain MAX_HOOK_ID_LEN). */
export const HookId = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/, 'Must be a lowercase hook identifier (a-z, 0-9, ., _, -).')
  .refine((v) => new TextEncoder().encode(v).length <= 48, 'Must be at most 48 UTF-8 bytes.')

/**
 * Response enum schema that accepts both known values and unknown future strings,
 * typed as `Known | (string & {})`.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.union([z.enum(values), z.string()]) as z.ZodType<T[number] | (string & {})>
}

/** Offset cursors as strings, so a later switch to opaque cursors changes no client. */
export const PageQuery = z.strictObject({
  cursor: z.string().regex(/^[0-9]+$/).max(12).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
})
export type PageQuery = z.output<typeof PageQuery>

export const PageInfo = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
})
export type PageInfo = z.output<typeof PageInfo>

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: PageInfo,
    asOf: Timestamp,
  })

/** One page of an in-memory list, in the shape `page(item)` describes. */
export function paginate<T>(rows: readonly T[], q: PageQuery, asOf = new Date().toISOString()) {
  const start = Number(q.cursor ?? 0)
  const hasMore = start + q.limit < rows.length
  return {
    items: rows.slice(start, start + q.limit),
    page: { nextCursor: hasMore ? String(start + q.limit) : null, hasMore },
    asOf,
  }
}
