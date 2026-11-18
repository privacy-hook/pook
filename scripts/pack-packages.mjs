import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'dist-packages')
const manifestPath = path.join(outDir, 'manifest.json')
const contractPkgPath = path.join(root, 'contract', 'package.json')
const sdkPkgPath = path.join(root, 'sdk', 'package.json')
const rootPkgPath = path.join(root, 'package.json')
const versionFilePath = path.join(root, 'contract', 'src', 'version.ts')

const args = new Set(process.argv.slice(2))
const forceBump = args.has('--bump')
const noBump = args.has('--no-bump')
const shouldBump = forceBump || (!noBump && existsSync(manifestPath))

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function bumpPatch(version) {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver version: ${version}`)
  }
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
}

const contractPkg = readJson(contractPkgPath)
const sdkPkg = readJson(sdkPkgPath)
const rootPkg = readJson(rootPkgPath)

const nextVersion = shouldBump ? bumpPatch(contractPkg.version) : contractPkg.version
if (shouldBump) {
  contractPkg.version = nextVersion
  sdkPkg.version = nextVersion
  if (rootPkg.dependencies?.['@pook/contract']) rootPkg.dependencies['@pook/contract'] = nextVersion
  if (rootPkg.dependencies?.['@pook/sdk']) rootPkg.dependencies['@pook/sdk'] = nextVersion
  writeJson(contractPkgPath, contractPkg)
  writeJson(sdkPkgPath, sdkPkg)
  writeJson(rootPkgPath, rootPkg)
  writeFileSync(versionFilePath, `export const CONTRACT_VERSION = '${nextVersion}'\n`, 'utf8')
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const runNpm = (npmArgs, cwd = root) =>
  execFileSync(npmCmd, npmArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

runNpm(['run', 'build:contract'])
runNpm(['run', 'build:sdk'])

mkdirSync(outDir, { recursive: true })
runNpm(['pack', '--pack-destination', outDir], path.join(root, 'contract'))
runNpm(['pack', '--pack-destination', outDir], path.join(root, 'sdk'))

// @pook/circuits: the circuits' WASM (transaction builders and the Xark prover) that the SDK takes as
// `createPook({ wasm })`. One call for both runtimes: `const wasm = await loadCircuits()` picks the web
// build in a browser and the Node build under Node (package exports conditions).
const circuitsStage = path.join(outDir, '.circuits-stage')
rmSync(circuitsStage, { recursive: true, force: true })
for (const target of ['web', 'node']) {
  cpSync(path.join(root, 'program', 'wasm', target), path.join(circuitsStage, target), { recursive: true })
  rmSync(path.join(circuitsStage, target, '.gitignore'), { force: true }) // wasm-pack's '*' would empty the tarball
}
writeFileSync(path.join(circuitsStage, 'web.js'), `import init, * as circuits from './web/pook_program.js'
let ready
/** The circuits module, initialized once. */
export async function loadCircuits() {
  ready ??= init({ module_or_path: new URL('./web/pook_program_bg.wasm', import.meta.url) }).then(() => circuits)
  return ready
}
`)
writeFileSync(path.join(circuitsStage, 'node.js'), `import { createRequire } from 'node:module'
const circuits = createRequire(import.meta.url)('./node/pook_program.js')
/** The circuits module (the Node build loads its WASM on require). */
export async function loadCircuits() {
  return circuits
}
`)
writeFileSync(path.join(circuitsStage, 'index.d.ts'), `export type Circuits = typeof import('./web/pook_program.js')
export function loadCircuits(): Promise<Circuits>
`)
writeJson(path.join(circuitsStage, 'package.json'), {
  name: '@pook/circuits',
  version: nextVersion,
  type: 'module',
  types: './index.d.ts',
  exports: {
    '.': { types: './index.d.ts', node: './node.js', default: './web.js' },
    './web/*': './web/*',
    './node/*': './node/*',
  },
  sideEffects: false,
})
runNpm(['pack', '--pack-destination', outDir], circuitsStage)
rmSync(circuitsStage, { recursive: true, force: true })

const contractFile = `pook-contract-${nextVersion}.tgz`
const sdkFile = `pook-sdk-${nextVersion}.tgz`
const circuitsFile = `pook-circuits-${nextVersion}.tgz`

writeJson(manifestPath, {
  version: nextVersion,
  contract: contractFile,
  sdk: sdkFile,
  circuits: circuitsFile,
  packedAt: new Date().toISOString(),
})

console.log(`Packed ${contractFile}, ${sdkFile} and ${circuitsFile} into ${outDir}`)
