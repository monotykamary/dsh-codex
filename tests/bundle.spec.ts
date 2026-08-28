import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Codex bundle composition', () => {
  it('uses the shared multiprovider row without inserting a duplicate', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain("name: '@monotykamary/dsh-codex'")
    expect(patch).not.toContain('name: dsh-multiprovider')
  })
})
