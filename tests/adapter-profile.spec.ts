import { describe, expect, it } from 'vitest'
import { createOpenAICodexAdapter, OPENAI_CODEX_REQUEST_IMAGE_LIMITS } from '../src/adapter.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

describe('OpenAI Codex adapter profile', () => {
  it('supplies complete positive image limits to the generic adapter', () => {
    expect(OPENAI_CODEX_REQUEST_IMAGE_LIMITS).toEqual({
      maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: 1024 * 1024,
    })
    expect(Object.values(OPENAI_CODEX_REQUEST_IMAGE_LIMITS).every(value => Number.isSafeInteger(value) && value > 0)).toBe(true)
    const adapter = createOpenAICodexAdapter(
      new OpenAICodexCredentialStore('/tmp/dsh-codex-adapter-profile.json'),
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
    )
    const config = (adapter as unknown as {
      config: { profiles: () => ReadonlyMap<string, object> }
    }).config
    expect(config.profiles().get(OPENAI_CODEX_PROVIDER)).toMatchObject(OPENAI_CODEX_REQUEST_IMAGE_LIMITS)
  })
})
