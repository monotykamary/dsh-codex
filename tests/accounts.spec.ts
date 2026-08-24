import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { MultiProviderService } from 'dsh-multiprovider'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICodexAccountPool } from '../src/account-pool.ts'
import { OpenAICodexAccounts } from '../src/accounts.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/store.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function credential(accountId: string): OAuthCredential {
  return {
    type: 'oauth',
    access: `access-${accountId}`,
    refresh: `refresh-${accountId}`,
    expires: Date.now() + 3_600_000,
    accountId,
  }
}

async function enroll(accounts: OpenAICodexAccounts, accountId: string) {
  const pending = await accounts.beginLogin()
  await pending.store.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential(accountId)))
  return accounts.commitLogin(pending)
}

describe('OpenAI Codex multi-account registry', () => {
  it('publishes independent owner-only account stores and removes one stable account', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-accounts-'))
    const accounts = new OpenAICodexAccounts(root)
    const first = await enroll(accounts, 'account-one')
    const second = await enroll(accounts, 'account-two')

    expect((await accounts.list()).map(account => account.label)).toEqual([
      'ChatGPT · untone',
      'ChatGPT · unttwo',
    ])
    expect(first.id).not.toBe(second.id)
    expect(await accounts.remove(first.id)).toBe(true)
    expect((await accounts.list()).map(account => account.id)).toEqual([second.id])
  })

  it('deduplicates a repeated provider account and round-robins scheduler leases', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-pool-'))
    const accounts = new OpenAICodexAccounts(root)
    await enroll(accounts, 'account-one')
    await enroll(accounts, 'account-one')
    await enroll(accounts, 'account-two')
    expect(await accounts.list()).toHaveLength(2)

    const scheduler = new MultiProviderService({ affinity: false })
    const pool = new OpenAICodexAccountPool(accounts, scheduler)
    const unregister = pool.register()
    try {
      const first = await pool.acquire()
      first.release({ status: 'success' })
      const second = await pool.acquire()
      second.release({ status: 'success' })
      expect(first.accountId).not.toBe(second.accountId)
    } finally {
      unregister()
    }
  })
})
