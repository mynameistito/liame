import { app, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountConfig, PublicAccount } from '../shared/types'

// The whole config, password included, is encrypted with the macOS Keychain-backed key.
const file = () => join(app.getPath('userData'), 'account.bin')

export async function loadAccount(): Promise<AccountConfig | null> {
  if (!existsSync(file())) return null
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(await readFile(file()))
    const account: AccountConfig = JSON.parse(result)
    if (shouldReEncrypt) await storeAccount(account)
    return account
  } catch {
    return null
  }
}

export async function storeAccount(account: AccountConfig): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Keychain encryption is not available.')
  await writeFile(file(), await safeStorage.encryptStringAsync(JSON.stringify(account)), { mode: 0o600 })
}

export async function clearAccount(): Promise<void> {
  await rm(file(), { force: true })
}

export function toPublic({ password: _password, ...rest }: AccountConfig): PublicAccount {
  return rest
}
