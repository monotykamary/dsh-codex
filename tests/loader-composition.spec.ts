import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import Include from '@monotykamary/cordis-plugin-include'
import Loader from '@monotykamary/cordis-plugin-loader'
import LlmRuntime from '@monotykamary/dsh-llm'
import WebRuntime from '@monotykamary/dsh-web'
import * as OpenAICodex from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('OpenAI Codex real composition', () => {
  it('loads through the Loader, exposes the catalog, and unregisters on disposal', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: 'test-llm-service'",
      '- id: web',
      "  name: 'test-web-service'",
      '- id: llm-openai-codex',
      "  name: '@monotykamary/dsh-codex'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-llm-service', LlmRuntime],
      ['test-web-service', WebRuntime],
      ['@monotykamary/dsh-codex', OpenAICodex],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    expect(ctx.llm.listProviders()).toEqual([{ id: 'openai-codex', name: 'OpenAI Codex' }])
    const models = await ctx.llm.listModels('openai-codex')
    expect(models.some(model => model.id === 'gpt-5.6-sol')).toBe(true)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@monotykamary/dsh-codex')
    if (entry === undefined) throw new Error('OpenAI Codex Loader entry missing')
    if (entry.fiber === undefined) throw new Error('OpenAI Codex plugin fiber missing')
    await entry.fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
