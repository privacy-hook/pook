import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const sdkDir = path.dirname(fileURLToPath(import.meta.url))
const tscBin = path.resolve(sdkDir, '../node_modules/typescript/bin/tsc')

// 0. Clean stale JS/d.ts files
rmSync(path.join(sdkDir, 'dist'), { recursive: true, force: true })

// 1. Emit declaration files (.d.ts) with tsc
execFileSync(process.execPath, [tscBin, '-p', path.join(sdkDir, 'tsconfig.json'), '--emitDeclarationOnly'], {
  cwd: sdkDir,
  stdio: 'inherit',
})

// 2. esbuild plugin patching @lightprotocol/hasher.rs browser-fat build:
//    - strips the two dead `new URL('...wasm', import.meta.url)` expressions that break Next/Turbopack
//    - passes `{ module_or_path }` to `__wbg_init` / `__wbg_init$1`
//    - removes the wasm-bindgen deprecation warning string
const patchLightHasherPlugin = {
  name: 'patch-light-hasher',
  setup(buildApi) {
    buildApi.onLoad({ filter: /@lightprotocol[\\/]hasher\.rs[\\/]dist[\\/].*\.js$/ }, (args) => {
      let contents = readFileSync(args.path, 'utf8')
      contents = contents
        .replace(/module_or_path\s*=\s*new URL\(['"]light_wasm_hasher_bg\.wasm['"],\s*import\.meta\.url\);/g, "throw new Error('Inline light_wasm_hasher_bg.wasm missing');")
        .replace(/module_or_path\s*=\s*new URL\(['"]hasher_wasm_simd_bg\.wasm['"],\s*import\.meta\.url\);/g, "throw new Error('Inline hasher_wasm_simd_bg.wasm missing');")
        .replace(/console\.warn\(['"]using deprecated parameters for the initialization function; pass a single object instead['"]\);/g, '')
        .replace(/__wbg_init\((module\s*\?\?\s*wasmSimdInit\?\.\(\))\)/g, '__wbg_init({ module_or_path: $1 })')
        .replace(/__wbg_init\$1\((module\s*\?\?\s*wasmInit\?\.\(\))\)/g, '__wbg_init$1({ module_or_path: $1 })')
      return { contents, loader: 'js' }
    })
  },
}

// 3. Bundle @pook/sdk with @heliuslabs/spr and @lightprotocol/hasher.rs inlined; keep peer/direct deps external
await build({
  entryPoints: [path.join(sdkDir, 'src/index.ts')],
  outfile: path.join(sdkDir, 'dist/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser', 'import', 'default'],
  external: [
    '@pook/contract',
    '@pook/contract/*',
    '@solana/kit',
    '@noble/hashes',
    '@noble/hashes/*',
    'zod',
  ],
  plugins: [patchLightHasherPlugin],
})
