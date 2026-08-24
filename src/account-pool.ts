/** Bridge provider-owned Codex account stores into the generic multiprovider scheduler. */

import type { AccountLease, FailureDisposition, MultiProviderService } from 'dsh-multiprovider'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import type { OpenAICodexAccounts } from './accounts.ts'

function diagnostics(error: unknown, seen = new Set<unknown>()): string {
  if (error === null || error === undefined || seen.has(error)) return ''
  seen.add(error)
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const value = error as Record<string, unknown>
  return [value['message'], value['code'], value['status'], diagnostics(value['cause'], seen)]
    .filter(part => part !== undefined)
    .join(' ')
}

/** Classify bounded status/code diagnostics; never include this string in public state. */
export function classifyOpenAICodexFailure(error: unknown): FailureDisposition {
  const text = diagnostics(error).toLowerCase()
  if (/429|rate.?limit|too many requests/u.test(text)) return { kind: 'rate-limit', retryable: true }
  if (/quota|usage.?limit|insufficient.?credit/u.test(text)) return { kind: 'quota', retryable: true }
  if (/40[13]|unauthori[sz]ed|forbidden|credential|access token/u.test(text)) return { kind: 'auth', retryable: true }
  if (/5[0-9][0-9]|timeout|timed out|econn|network|socket|temporar/u.test(text)) return { kind: 'transient', retryable: true }
  return { kind: 'fatal', retryable: false }
}

export type OpenAICodexAccountLease = AccountLease<OpenAICodexCredentialStore>

export class OpenAICodexAccountPool {
  constructor(
    readonly accounts: OpenAICodexAccounts,
    readonly scheduler: MultiProviderService,
  ) {}

  register(): () => void {
    return this.scheduler.registerProvider<OpenAICodexCredentialStore>({
      id: OPENAI_CODEX_PROVIDER,
      label: 'OpenAI Codex',
      accounts: async () => (await this.accounts.list()).map(account => ({
        id: account.id,
        label: account.label,
        authKind: 'oauth',
        credentialRef: account.store,
        metadata: {
          expiresAt: account.expiresAt.toISOString(),
          legacy: account.legacy,
        },
      })),
      classifyFailure: classifyOpenAICodexFailure,
      managementHint: 'Add or remove ChatGPT accounts in Settings → OpenAI Codex.',
    })
  }

  acquire(affinityKey?: string, excludeAccountIds?: Iterable<string>): Promise<OpenAICodexAccountLease> {
    return this.scheduler.acquire<OpenAICodexCredentialStore>({
      providerId: OPENAI_CODEX_PROVIDER,
      ...affinityKey === undefined ? {} : { affinityKey },
      ...excludeAccountIds === undefined ? {} : { excludeAccountIds },
    })
  }
}
