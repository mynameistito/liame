import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountConfig, AccountInput, PublicAccount } from '../shared/types'

// Every account, passwords included, is encrypted with the macOS Keychain-backed key.
const file = () => join(app.getPath('userData'), 'accounts.bin')
// The single-account file from before multiple accounts existed.
const legacyFile = () => join(app.getPath('userData'), 'account.bin')

async function decrypt(path: string): Promise<unknown> {
  const { result } = await safeStorage.decryptStringAsync(await readFile(path))
  return JSON.parse(result)
}

export async function loadAccounts(): Promise<AccountConfig[]> {
  try {
    if (existsSync(file())) return (await decrypt(file())) as AccountConfig[]
    if (existsSync(legacyFile())) {
      // Earlier versions only supported Zoho, so the old account is one.
      const legacy = (await decrypt(legacyFile())) as Omit<AccountConfig, 'id' | 'provider'>
      const migrated: AccountConfig[] = [{ ...legacy, id: randomUUID(), provider: 'zoho' }]
      await storeAccounts(migrated)
      await rm(legacyFile(), { force: true })
      return migrated
    }
  } catch {
    // An unreadable store behaves like no accounts; setup runs again.
  }
  return []
}

export async function storeAccounts(accounts: AccountConfig[]): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Keychain encryption is not available.')
  await writeFile(file(), await safeStorage.encryptStringAsync(JSON.stringify(accounts)), { mode: 0o600 })
}

/** Adds a new account or replaces the one with the same id. */
export function upsert(accounts: AccountConfig[], input: AccountInput): { list: AccountConfig[]; account: AccountConfig } {
  const account: AccountConfig = { ...input, id: input.id ?? randomUUID() }
  const exists = accounts.some((a) => a.id === account.id)
  return { account, list: exists ? accounts.map((a) => (a.id === account.id ? account : a)) : [...accounts, account] }
}

export function toPublic({ password: _password, ...rest }: AccountConfig): PublicAccount {
  return rest
}
