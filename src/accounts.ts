/** Multi-account inventory layered over provider-owned per-account OAuth stores. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { withFileLock } from '@monotykamary/dsh-atomic-write'
import { resolveDshHome } from '@monotykamary/dsh-home-paths'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER, openAICodexAuthPath } from './store.ts'

const ACCOUNT_DIRECTORY = 'openai-codex-accounts'
const ACCOUNT_FILE_SUFFIX = '.auth.json'

export interface OpenAICodexAccount {
  /** Stable, secret-free scheduler and browser identifier. */
  id: string
  /** Human-readable label that does not disclose tokens or the full provider account id. */
  label: string
  store: OpenAICodexCredentialStore
  expiresAt: Date
  legacy: boolean
}

export interface PendingOpenAICodexAccount {
  id: string
  store: OpenAICodexCredentialStore
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function stableId(accountId: string): string {
  return createHash('sha256').update(accountId).digest('base64url').slice(0, 22)
}

function accountLabel(accountId: string): string {
  const suffix = accountId.replace(/[^A-Za-z0-9]/gu, '').slice(-6)
  return suffix.length === 0 ? 'ChatGPT account' : `ChatGPT · ${suffix}`
}

async function oauth(store: OpenAICodexCredentialStore): Promise<OAuthCredential | undefined> {
  const credential = await store.read(OPENAI_CODEX_PROVIDER)
  return credential?.type === 'oauth' ? credential : undefined
}

function providerAccountId(credential: OAuthCredential): string {
  if (typeof credential.accountId !== 'string' || credential.accountId.length === 0) {
    throw new Error('openai-codex: stored OAuth credential has no provider account id')
  }
  return credential.accountId
}

/** Discovers legacy and newly enrolled accounts without placing raw credentials in shared state. */
export class OpenAICodexAccounts {
  readonly directory: string
  readonly legacyStore: OpenAICodexCredentialStore
  private readonly lockfile: string

  constructor(dshHome?: string, legacyStore?: OpenAICodexCredentialStore) {
    const home = resolveDshHome(dshHome)
    this.directory = resolve(join(home, ACCOUNT_DIRECTORY))
    this.lockfile = join(this.directory, '.registry')
    this.legacyStore = legacyStore ?? new OpenAICodexCredentialStore(openAICodexAuthPath(home))
  }

  /** Return a fresh deduplicated account inventory. New-format accounts win over legacy storage. */
  async list(): Promise<OpenAICodexAccount[]> {
    const accounts = new Map<string, OpenAICodexAccount>()
    let names: string[] = []
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
    for (const name of names.sort()) {
      if (!name.endsWith(ACCOUNT_FILE_SUFFIX) || name.startsWith('.pending-')) continue
      const store = new OpenAICodexCredentialStore(join(this.directory, name))
      const credential = await oauth(store)
      if (credential === undefined) continue
      const accountId = providerAccountId(credential)
      const id = stableId(accountId)
      if (name !== `${id}${ACCOUNT_FILE_SUFFIX}`) continue
      accounts.set(id, {
        id,
        label: accountLabel(accountId),
        store,
        expiresAt: new Date(credential.expires),
        legacy: false,
      })
    }
    const legacyCredential = await oauth(this.legacyStore)
    if (legacyCredential !== undefined) {
      const accountId = providerAccountId(legacyCredential)
      const id = stableId(accountId)
      if (!accounts.has(id)) accounts.set(id, {
        id,
        label: accountLabel(accountId),
        store: this.legacyStore,
        expiresAt: new Date(legacyCredential.expires),
        legacy: true,
      })
    }
    return [...accounts.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
  }

  async account(id: string): Promise<OpenAICodexAccount | undefined> {
    return (await this.list()).find(account => account.id === id)
  }

  /** Allocate a private temporary store for one in-progress browser OAuth flow. */
  async beginLogin(): Promise<PendingOpenAICodexAccount> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      const mode = (await stat(this.directory)).mode
      if ((mode & 0o077) !== 0) throw new Error('openai-codex: account directory must be accessible only by its owner')
    }
    const id = randomUUID()
    return { id, store: new OpenAICodexCredentialStore(join(this.directory, `.pending-${id}.auth.json`)) }
  }

  /** Atomically publish a completed login, replacing a duplicate account and migrating legacy storage. */
  async commitLogin(pending: PendingOpenAICodexAccount): Promise<OpenAICodexAccount> {
    const credential = await oauth(pending.store)
    if (credential === undefined) throw new Error('openai-codex: OAuth completed without a stored credential')
    const accountId = providerAccountId(credential)
    const id = stableId(accountId)
    const target = join(this.directory, `${id}${ACCOUNT_FILE_SUFFIX}`)
    await withFileLock(this.lockfile, async () => {
      await rm(target, { force: true })
      await rename(pending.store.filename, target)
      const legacy = await oauth(this.legacyStore)
      if (legacy !== undefined && providerAccountId(legacy) === accountId) await this.legacyStore.delete(OPENAI_CODEX_PROVIDER)
    })
    return {
      id,
      label: accountLabel(accountId),
      store: new OpenAICodexCredentialStore(target),
      expiresAt: new Date(credential.expires),
      legacy: false,
    }
  }

  async discardLogin(pending: PendingOpenAICodexAccount): Promise<void> {
    await rm(pending.store.filename, { force: true })
  }

  /** Remove exactly one stable account id. */
  async remove(id: string): Promise<boolean> {
    const account = await this.account(id)
    if (account === undefined) return false
    await account.store.delete(OPENAI_CODEX_PROVIDER)
    return true
  }

  /** Remove all provider-owned Codex credentials. */
  async removeAll(): Promise<void> {
    for (const account of await this.list()) await account.store.delete(OPENAI_CODEX_PROVIDER)
  }
}

export function openAICodexAccountDirectory(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), ACCOUNT_DIRECTORY))
}
