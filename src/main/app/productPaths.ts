// SemaPath Replica modification, 2026-10-25.
import os from 'node:os'
import path from 'node:path'
import { PRODUCT_HOME_DIRECTORY, PRODUCT_PROFILE_DIRECTORY } from '@shared/productIdentity'

function absoluteOverride(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (!path.isAbsolute(trimmed)) throw new Error('Replica data directories must be absolute paths')
  return path.resolve(trimmed)
}

export function getProductUserDataPath(appDataDirectory: string, override?: string): string {
  return absoluteOverride(override) ?? path.join(appDataDirectory, PRODUCT_PROFILE_DIRECTORY)
}

export function getProductHomePath(
  homeDirectory: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  return (
    absoluteOverride(env.SEMAPATH_REPLICA_HOME) ?? path.join(homeDirectory, PRODUCT_HOME_DIRECTORY)
  )
}
