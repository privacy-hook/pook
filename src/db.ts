import { PrismaClient } from '@prisma/client'
import { createDatabase } from './engines/server/db.js'

export function createPookDatabase(url: string) {
  return createDatabase(url, (adapter) => new PrismaClient({ adapter }))
}

export type PookDatabase = ReturnType<typeof createPookDatabase>
