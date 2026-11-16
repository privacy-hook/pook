// Typed interface for the compiled Pook Xark WASM module (`program/wasm/{web,node}/pook_program.d.ts`).
// Kept as an injected interface so @pook/sdk stays 100% browser-safe while supporting both web and Node targets.

export type WasmBytes = Uint8Array | ArrayBuffer

export interface WasmProofBundle {
  numPublicInputs: number
  proof: Uint8Array
  publicInputs: Uint8Array
  free?(): void
}

export interface WasmProgramTransaction {
  finalizedTx: unknown
  proofInputs: Record<string, string>
  publicHash: Uint8Array
}

export interface WasmDataUtxo<T> {
  utxo: unknown
  data: T
  address?: Uint8Array
}

export interface WasmSeatNote {
  seatSecret: Uint8Array
}

export interface WasmProvingSession {
  prove(inputs: Record<string, string>, options?: unknown): WasmProofBundle
  free?(): void
}

export interface PookWasmModule {
  ProvingSession?: new (circuitXbc: WasmBytes, pkBytes: WasmBytes, sources?: string | null) => WasmProvingSession
  runTransaction(inputs: unknown, sender: Uint8Array | number[], payer: string): WasmProgramTransaction
  leaveTransaction(inputs: unknown, sender: Uint8Array | number[], payer: string): WasmProgramTransaction
  seatOpenTransaction(inputs: unknown, sender: Uint8Array | number[], payer: string): WasmProgramTransaction
  seatFundTransaction(inputs: unknown, sender: Uint8Array | number[], payer: string): WasmProgramTransaction
  seatActionTransaction(inputs: unknown, sender: Uint8Array | number[], payer: string): WasmProgramTransaction
  seatCloseTransaction(inputs: unknown, sender: Uint8Array | number[], payer: string): WasmProgramTransaction
  seatNoteDataUtxo(utxo: unknown): WasmDataUtxo<WasmSeatNote>
  checkProvingKey(provingKey: Uint8Array | number[], expectedSha256?: Uint8Array | number[] | null): void
  prove(circuitXbc: WasmBytes, pkBytes: WasmBytes, inputs: Record<string, string>, sources?: string | null): WasmProofBundle
  compressedProgramProof(proof: Uint8Array | number[]): Uint8Array
  poseidon2(inputs: string[]): string
}
