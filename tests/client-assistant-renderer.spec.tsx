// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatViewSlotProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  CodexAssistantBody, registerCodexAssistantRenderer,
} from '../src/client/CodexAssistantRenderer.tsx'
import { assistantStyleText } from '../src/client/CodexAssistantStyles.ts'

const translations: Record<string, string> = {
  copy: 'Copy',
  copied: 'Copied',
  'message.stopped': 'Stopped',
  'message.unknownBlock': 'Unknown block',
  'image.serviceUnavailable': 'Image service unavailable',
  'row.running': 'Running',
}

const t = ((key: string, params?: Record<string, unknown>) => {
  if (key === 'json.truncated') return `${String(params?.total)} entries`
  return translations[key] ?? key
}) as ChatViewSlotProps['t']

afterEach(cleanup)

describe('Codex assistant renderer bridge', () => {
  it('shadows only the assistant-step keyed cell at a lower priority', () => {
    const registrations: { options: Record<string, unknown>; component: unknown }[] = []
    const ctx = {
      effect: (install: () => unknown) => install(),
      slots: {
        inject: (_name: string, register: () => void) => { register() },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    } as unknown as ClientContext

    registerCodexAssistantRenderer(ctx)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.options).toMatchObject({
      name: 'conversation.chat.node', key: 'assistant-step', priority: -10, locale: 'conversation',
    })
  })

  it('strips Markdown markers from the summary and renders the expanded reasoning body', () => {
    const view = render(
      <CodexAssistantBody
        blocks={[
          { kind: 'reasoning', text: '**Inspect** the session\n\nCheck `persistence`' },
          { kind: 'text', text: 'Final **answer**' },
        ]}
        streaming={false}
        t={t}
      />,
    )

    expect(view.getByText('Inspect the session')).toBeTruthy()
    expect(view.container.textContent).not.toContain('**')
    expect(view.getByText('answer').tagName).toBe('STRONG')

    fireEvent.click(view.getByText('Think'))
    expect(view.getByText('Inspect').tagName).toBe('STRONG')
    expect(view.getByText('persistence').tagName).toBe('CODE')
    expect(assistantStyleText).toContain('font-size:.875em!important')
    expect(assistantStyleText).toContain('font:inherit!important')
  })

  it('keeps tool-only settled steps visually empty', () => {
    const view = render(
      <CodexAssistantBody
        blocks={[{ kind: 'tool-call', callId: 'call-1', name: 'bash', argsRaw: '{}' }]}
        streaming={false}
        t={t}
      />,
    )
    expect(view.container.firstChild).toBeNull()
  })
})
