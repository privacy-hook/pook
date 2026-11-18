import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const roles = {
  api: 'dist/src/roles/api.js',
  relayer: 'dist/src/roles/relayer.js',
  prover: 'dist/src/roles/prover.js',
  indexer: 'dist/src/roles/indexer.js',
  crank: 'dist/src/roles/crank.js',
}

const role = process.argv[2]
if (!role || !Object.hasOwn(roles, role)) {
  throw new Error(`Usage: node start-service.mjs <${Object.keys(roles).join('|')}>`)
}

try {
  process.loadEnvFile(path.join(root, '.env'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const env = process.platform === 'win32' ? { ...process.env, APPDATA: path.join(root, 'node_modules/.cache') } : process.env

let current = null
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    current?.kill(signal)
  })
}

function run(script, args) {
  return new Promise((resolve, reject) => {
    current = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    current.once('error', reject)
    current.once('exit', (code) => resolve(code ?? 1))
  })
}

const skipMigrate = role === 'prover' || (role === 'api' && process.env.MODE === 'fixture') || !process.env.DATABASE_URL
let migrated = 0
if (!skipMigrate) {
  migrated = await run('node_modules/prisma/build/index.js', ['migrate', 'deploy'])
}
process.exitCode = migrated !== 0 || stopping ? migrated : await run(roles[role], [])
