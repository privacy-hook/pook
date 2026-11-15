// One error envelope for every failed response: a stable code the UI branches on, a sentence it can
// show, whether retrying can help, and the stage of the flow that failed. Response error schemas
// tolerate unknown fields and unknown codes/stages so additive backend changes never break clients.

import { z } from 'zod'
import { Address, openEnum } from './primitives.js'

/** The codes every API speaks. Pook adds its own with defineErrors. */
export const BASE_ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  PROGRAM_UNAVAILABLE: 409,
  CONFIGURATION_REQUIRED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  TRANSACTION_EXPIRED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SIMULATION_FAILED: 422,
  CHAIN_REFUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_UNAVAILABLE: 502,
} as const
export type BaseErrorCode = keyof typeof BASE_ERROR_STATUS

export const KNOWN_ERROR_STAGES = [
  'validation',
  'auth',
  'read',
  'upload',
  'build',
  'wallet',
  'wallet_rejected',
  'co_sign',
  'simulation',
  'proving',
  'relay',
  'send',
  'confirmation',
  'expired',
] as const

export const ErrorStage = openEnum(KNOWN_ERROR_STAGES)
export type KnownErrorStage = (typeof KNOWN_ERROR_STAGES)[number]
export type ErrorStage = KnownErrorStage | (string & {})

/** The program that refused a transaction, by address, so overlapping custom codes stay unambiguous. */
export const ProgramError = z.object({
  programId: Address,
  name: z.string(),
  number: z.int().optional(),
})
export type ProgramError = z.output<typeof ProgramError>

const fields = <C extends z.ZodType<string>>(code: C) =>
  z.object({
    code,
    message: z.string(),
    retryable: z.boolean(),
    stage: ErrorStage,
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    programError: ProgramError.optional(),
    retryAfterSeconds: z.int().optional(),
    requestId: z.string().optional(),
  })

export type ApiErrorDetail<Code extends string = string> = {
  code: Code
  message: string
  retryable: boolean
  stage: ErrorStage
  fieldErrors?: Record<string, string[]>
  programError?: ProgramError
  retryAfterSeconds?: number
  requestId?: string
}

export type ApiErrorBody<Code extends string = string> = {
  error: ApiErrorDetail<Code>
}

/** The product's error table: the base codes plus its own, as a status map and zod schemas. */
export function defineErrors<const Extra extends Record<string, number>>(extra: Extra) {
  const status = { ...BASE_ERROR_STATUS, ...extra } as typeof BASE_ERROR_STATUS & Extra
  type KnownCode = keyof typeof status & string
  const knownCodes = Object.keys(status) as [KnownCode, ...KnownCode[]]
  const KnownErrorCode = z.enum(knownCodes)
  const ErrorCode = openEnum(knownCodes)
  const ErrorDetail = fields(ErrorCode)
  const ApiError = z.object({ error: ErrorDetail })
  return { status, knownCodes, KnownErrorCode, ErrorCode, ErrorDetail, ApiError }
}

export const baseErrors = defineErrors({})
