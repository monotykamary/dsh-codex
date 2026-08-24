/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { createModels } from '@earendil-works/pi-ai'
import type { MutableModels, Provider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { LlmAdapter, resolveRetryPolicy } from '@monotykamary/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, ResolvedRetryPolicy, StreamChunk } from '@monotykamary/dsh-llm'
import { PiAiAdapter } from '@monotykamary/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@monotykamary/dsh-llm-pi-ai'
import type { AttachmentStore } from '@monotykamary/dsh-attachment'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import type { OpenAICodexAccountPool } from './account-pool.ts'
import { OpenAICodexResponseRuntime } from './responses.ts'
import type { ResponseApiPreferences } from './tool-policy.ts'

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Complete request-image limits required by the generic pi-ai adapter. */
export const OPENAI_CODEX_REQUEST_IMAGE_LIMITS = {
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
} as const

/**
 * Give the generic dsh adapter a request-scoped bearer-token entry without
 * changing the provider's user-facing OAuth flow. The resolver accepts only
 * the explicit override supplied by this plugin; it never discovers an API
 * key from the environment or persistent api-key credentials.
 */
function requestProvider(provider: Provider): Provider {
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'OpenAI Codex OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'OAuth' }
        },
      },
    },
  }
}

/** Preserve Harness call purpose until the generic pi-ai adapter reaches the provider. */
class OpenAICodexAdapter extends PiAiAdapter {
  constructor(
    options: ConstructorParameters<typeof PiAiAdapter>[0],
    private readonly responses: OpenAICodexResponseRuntime,
  ) {
    super(options)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const release = options.purpose === 'compaction'
      ? this.responses.enterCompaction(options.sessionId === undefined ? undefined : String(options.sessionId))
      : undefined
    try {
      for await (const chunk of super.stream(options)) yield chunk
    } finally {
      release?.()
    }
  }
}

/**
 * Create the Codex subscription adapter without requiring a dsh fork. The
 * public pi-ai adapter owns Harness message conversion, image attachment
 * resolution, streaming, and reasoning metadata. This plugin adds optional
 * Codex-native request state/compaction and supplies the provider OAuth token.
 */
function createSingleOpenAICodexAdapter(
  credentials: OpenAICodexCredentialStore,
  resolveAttachments: () => AttachmentStore | undefined,
  responsePreferences: () => ResponseApiPreferences,
): PiAiAdapter {
  const provider = openaiCodexProvider()
  const responses = new OpenAICodexResponseRuntime(responsePreferences)
  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[OPENAI_CODEX_PROVIDER, {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-openai-codex retryPolicy'),
    configuredMaxTokens: new Map(),
    ...OPENAI_CODEX_REQUEST_IMAGE_LIMITS,
    piProvider: responses.wrap(requestProvider(provider)),
  }]])
  const models: MutableModels = createModels({ credentials })
  models.setProvider(provider)
  return new OpenAICodexAdapter({
    profiles: () => profiles,
    auth: {
      credentials,
      authContext: {
        env: () => Promise.resolve(undefined),
        fileExists: () => Promise.resolve(false),
      },
    },
    resolveApiKey: async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments,
  }, responses)
}

/** Route complete streams through one leased account without sharing response state across accounts. */
class PooledOpenAICodexAdapter extends LlmAdapter {
  private readonly adapters = new Map<string, PiAiAdapter>()
  private readonly catalog: PiAiAdapter

  constructor(
    private readonly pool: OpenAICodexAccountPool,
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    private readonly responsePreferences: () => ResponseApiPreferences,
  ) {
    super()
    this.catalog = createSingleOpenAICodexAdapter(pool.accounts.legacyStore, resolveAttachments, responsePreferences)
  }

  private adapter(store: OpenAICodexCredentialStore): PiAiAdapter {
    let adapter = this.adapters.get(store.filename)
    if (adapter === undefined) {
      adapter = createSingleOpenAICodexAdapter(store, this.resolveAttachments, this.responsePreferences)
      this.adapters.set(store.filename, adapter)
    }
    return adapter
  }

  override providerInfo(provider: string): LlmProviderInfo { return this.catalog.providerInfo(provider) }
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined { return this.catalog.providerRetryPolicy(provider) }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> { return this.catalog.listModels(provider) }
  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolveModel(provider, model, signal)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.catalog.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const affinityKey = options.sessionId === undefined ? undefined : String(options.sessionId)
    const lease = await this.pool.acquire(affinityKey)
    let settled = false
    try {
      for await (const chunk of this.adapter(lease.credentialRef).stream(options)) yield chunk
      lease.release({ status: 'success' })
      settled = true
    } catch (error: unknown) {
      lease.release({ status: 'failure', error })
      settled = true
      throw error
    } finally {
      if (!settled) lease.release({ status: 'cancelled' })
    }
  }
}

/** Create a backwards-compatible single-account or multiprovider-backed Codex adapter. */
export function createOpenAICodexAdapter(
  credentials: OpenAICodexCredentialStore | OpenAICodexAccountPool,
  resolveAttachments: () => AttachmentStore | undefined,
  responsePreferences: () => ResponseApiPreferences,
): LlmAdapter {
  return 'acquire' in credentials
    ? new PooledOpenAICodexAdapter(credentials, resolveAttachments, responsePreferences)
    : createSingleOpenAICodexAdapter(credentials, resolveAttachments, responsePreferences)
}
