import { describe, expect, it } from 'vitest'
import { OPENAI_CODEX_REQUEST_IMAGE_LIMITS } from '../src/adapter.ts'

describe('OpenAI Codex adapter profile', () => {
  it('supplies complete positive image limits to the generic adapter', () => {
    expect(OPENAI_CODEX_REQUEST_IMAGE_LIMITS).toEqual({
      maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: 1024 * 1024,
    })
    expect(Object.values(OPENAI_CODEX_REQUEST_IMAGE_LIMITS).every(value => Number.isSafeInteger(value) && value > 0)).toBe(true)
  })
})
