// The browser's Solana RPC, relayed through the API. On top of the engine relay's read methods it
// lets one getProgramAccounts through: the Rings wallet sync's listing of SPL asset registrations
// on the Privacy Program (dataSize 48 and the registry discriminator at offset 0), the same for every
// holder, so it is answered from a short server cache instead of costing a scan per page.
import { RELAY_METHODS, rpcRelay } from '../engines/rpc/relay.js'
import type { Rpc } from '../engines/rpc/client.js'
import { env } from '../config.js'

const REGISTRY_TTL_MS = 60_000

type Request = { id: string | number; method: string; params: readonly unknown[] }

function isRegistryListing(params: readonly unknown[]): boolean {
  const [program, options] = params as [unknown, { filters?: unknown } | undefined]
  if (program !== env.RINGS_PROGRAM_ID || !options || !Array.isArray(options.filters)) return false
  const filters = options.filters as Array<Record<string, unknown>>
  return (
    filters.length === 2 &&
    filters.some((f) => Number(f.dataSize) === 48) &&
    filters.some((f) => {
      const m = f.memcmp as { offset?: unknown } | undefined
      return m !== undefined && Number(m.offset) === 0
    })
  )
}

export function pookRpcRelay(rpc: Rpc, ready: () => boolean) {
  const cache = new Map<string, { at: number; text: string; id: string }>()
  const forward: Rpc['forward'] = async (request: Request, maxWaitMs: number) => {
    if (request.method !== 'getProgramAccounts') return rpc.forward(request, maxWaitMs)
    if (!isRegistryListing(request.params)) {
      return JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'This getProgramAccounts query is not relayed.' } })
    }
    const key = JSON.stringify(request.params)
    const hit = cache.get(key)
    // The provider's text is kept as sent (u64 numbers byte for byte); only its id is swapped.
    if (hit && Date.now() - hit.at < REGISTRY_TTL_MS) {
      return hit.text.replace(`"id":${hit.id}`, `"id":${JSON.stringify(request.id)}`)
    }
    const text = await rpc.forward(request, maxWaitMs)
    if (!text.includes('"error"')) cache.set(key, { at: Date.now(), text, id: JSON.stringify(request.id) })
    return text
  }
  return rpcRelay({ rpc: { forward }, methods: [...RELAY_METHODS, 'getProgramAccounts'], ready })
}
