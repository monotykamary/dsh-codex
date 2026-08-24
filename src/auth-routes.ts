/** Same-origin Web settings routes for OpenAI Codex OAuth. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { Context } from '@monotykamary/cordis'
import type {} from '@monotykamary/dsh-host-webserver'
import { loginOpenAICodex } from './auth.ts'
import { OpenAICodexAccounts } from './accounts.ts'
import type { PendingOpenAICodexAccount } from './accounts.ts'
import type { OpenAICodexCredentialStore } from './store.ts'
import type { ImageToolPolicy, ImageToolPreferences, ResponseApiPreferences } from './tool-policy.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexUsage } from './usage.ts'

export const OPENAI_CODEX_AUTH_STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
export const OPENAI_CODEX_AUTH_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
export const OPENAI_CODEX_AUTH_LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
export const OPENAI_CODEX_IMAGE_TOOL_SETTINGS_PATH = '/plugins/dsh-openai-codex/image-tools'
export const OPENAI_CODEX_RESPONSE_API_SETTINGS_PATH = '/plugins/dsh-openai-codex/response-api'

export interface OpenAICodexWebAccountStatus {
  id: string
  label: string
  expiresAt: string
  legacy: boolean
  usage: OpenAICodexUsage
  quotaError?: string
}

export type OpenAICodexWebAuthStatus =
  | { status: 'signed-out'; accounts: [] }
  | { status: 'signing-in'; accounts: OpenAICodexWebAccountStatus[] }
  | { status: 'signed-in'; accounts: OpenAICodexWebAccountStatus[] }
  | { status: 'error'; accounts: OpenAICodexWebAccountStatus[]; message: string }

interface LoginChallenge { url: string }

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+/gu, '[redacted token]')
    .replace(/((?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 1000)
}

function waitForPromptAbort(prompt: AuthPrompt): Promise<string> {
  const signal = prompt.signal
  if (signal === undefined) return new Promise<string>(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

/** Owns one in-progress browser login while preserving every already enrolled account. */
export class OpenAICodexWebAuth {
  private state: OpenAICodexWebAuthStatus = { status: 'signed-out', accounts: [] }
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private challenge: LoginChallenge | undefined
  private pending: PendingOpenAICodexAccount | undefined
  private challengeWaiters: Array<{ resolve(value: LoginChallenge): void; reject(error: unknown): void }> = []

  private readonly accounts: OpenAICodexAccounts

  constructor(accounts: OpenAICodexAccounts | OpenAICodexCredentialStore) {
    this.accounts = 'beginLogin' in accounts ? accounts : new OpenAICodexAccounts(dirname(accounts.filename), accounts)
  }

  async status(): Promise<OpenAICodexWebAuthStatus> {
    if (this.operation !== undefined) return this.state
    if (this.state.status === 'error') return this.state
    return this.readStoredStatus()
  }

  async signIn(): Promise<LoginChallenge> {
    if (this.operation === undefined) await this.start()
    if (this.challenge !== undefined) return this.challenge
    return new Promise<LoginChallenge>((resolve, reject) => { this.challengeWaiters.push({ resolve, reject }) })
  }

  async signOut(accountId?: string): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex sign-in cancelled'))
    await this.operation?.catch(() => undefined)
    if (accountId === undefined) await this.accounts.removeAll()
    else await this.accounts.remove(accountId)
    this.state = await this.readStoredStatus()
  }

  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex plugin disposed'))
    await this.operation?.catch(() => undefined)
  }

  private async start(): Promise<void> {
    const cancellation = new AbortController()
    const pending = await this.accounts.beginLogin()
    this.cancellation = cancellation
    this.pending = pending
    this.challenge = undefined
    const existing = await this.readStoredStatus()
    this.state = { status: 'signing-in', accounts: existing.accounts }
    this.operation = loginOpenAICodex({
      signal: cancellation.signal,
      prompt: prompt => prompt.type === 'select' ? Promise.resolve('browser') : waitForPromptAbort(prompt),
      notify: event => { this.onEvent(event) },
    }, pending.store).then(
      async () => {
        await this.accounts.commitLogin(pending)
        this.state = await this.readStoredStatus()
      },
      async (error: unknown) => {
        await this.accounts.discardLogin(pending).catch(() => undefined)
        this.rejectChallenge(error)
        const stored = await this.readStoredStatus().catch((): OpenAICodexWebAuthStatus => ({ status: 'signed-out', accounts: [] }))
        this.state = { status: 'error', accounts: stored.accounts, message: safeMessage(error) }
      },
    ).finally(() => {
      this.operation = undefined
      this.cancellation = undefined
      this.pending = undefined
    })
  }

  private onEvent(event: AuthEvent): void {
    if (event.type !== 'auth_url') return
    const url = new URL(event.url)
    if (url.protocol !== 'https:') {
      const error = new Error('OpenAI returned an unsafe authorization URL')
      this.cancellation?.abort(error)
      this.rejectChallenge(error)
      return
    }
    const challenge = { url: event.url }
    this.challenge = challenge
    for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(challenge)
  }

  private async readStoredStatus(): Promise<OpenAICodexWebAuthStatus> {
    const stored = await this.accounts.list()
    if (stored.length === 0) return { status: 'signed-out', accounts: [] }
    const accounts = await Promise.all(stored.map(async account => {
      try {
        return {
          id: account.id, label: account.label, expiresAt: account.expiresAt.toISOString(), legacy: account.legacy,
          usage: await readOpenAICodexRateLimits(account.store),
        }
      } catch (error: unknown) {
        return {
          id: account.id, label: account.label, expiresAt: account.expiresAt.toISOString(), legacy: account.legacy,
          usage: { rateLimits: [] }, quotaError: safeMessage(error),
        }
      }
    }))
    return { status: 'signed-in', accounts }
  }

  private rejectChallenge(error: unknown): void {
    for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error)
  }
}

/** Whether a request comes from this loopback page rather than a remote site. */
function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.byteLength
    if (bytes > 16 * 1024) throw new Error('request body is too large')
    chunks.push(data)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value as Record<string, unknown>
}

function preferencePatch(value: Record<string, unknown>): Partial<ImageToolPreferences> {
  const allowed = new Set(['modifyReadImage', 'shareImagegenWithOtherModels'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('request contains an unknown image-tool setting')
  const patch: Partial<ImageToolPreferences> = {}
  for (const key of allowed as Set<keyof ImageToolPreferences>) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
    patch[key] = value[key]
  }
  return patch
}

function responseApiPatch(value: Record<string, unknown>): Partial<ResponseApiPreferences> {
  const allowed = new Set<keyof ResponseApiPreferences>(['useWebSocketContextReuse', 'useNativeCompaction'])
  if (Object.keys(value).some(key => !allowed.has(key as keyof ResponseApiPreferences))) {
    throw new Error('request contains an unknown Responses API setting')
  }
  const patch: Partial<ResponseApiPreferences> = {}
  for (const key of allowed) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
    patch[key] = value[key]
  }
  return patch
}

/** Register the plugin-owned OAuth routes when the Web server is composed. */
export function registerOpenAICodexAuthRoutes(
  ctx: Context,
  accounts: OpenAICodexAccounts | OpenAICodexCredentialStore,
  imageTools: ImageToolPolicy,
): void {
  const registry = 'beginLogin' in accounts ? accounts : new OpenAICodexAccounts(dirname(accounts.filename), accounts)
  const auth = new OpenAICodexWebAuth(registry)
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          json(res, 200, await auth.status())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            json(res, 200, await auth.signIn())
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            let accountId: string | undefined
            if (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') {
              const body = await readJson(req)
              if (Object.keys(body).some(key => key !== 'accountId')) throw new Error('request contains an unknown field')
              if (typeof body['accountId'] !== 'string' || body['accountId'].length === 0) throw new Error('accountId must be a non-empty string')
              accountId = body['accountId']
            }
            await auth.signOut(accountId)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 400, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_IMAGE_TOOL_SETTINGS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (req.method === 'GET') return json(res, 200, imageTools.snapshot())
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            json(res, 200, await imageTools.update(preferencePatch(await readJson(req))))
          } catch (error: unknown) {
            json(res, 400, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: OPENAI_CODEX_RESPONSE_API_SETTINGS_PATH,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (req.method === 'GET') return json(res, 200, imageTools.responseApiSnapshot())
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            json(res, 200, await imageTools.updateResponseApi(responseApiPatch(await readJson(req))))
          } catch (error: unknown) {
            json(res, 400, { error: safeMessage(error) })
          }
        },
      }),
    ]
    return async () => {
      for (const dispose of routes) dispose()
      await auth.dispose()
    }
  }, 'dsh-openai-codex: Web OAuth routes')
}
