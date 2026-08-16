/** Thin assistant-step bridge: preserve Harness block primitives and customize only reasoning. */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AssistantBlock, ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatNodeViewProps, ChatViewSlotProps, TurnTailOwnerProps,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ImageGallery } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ImageLoader, MessageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import {
  DisclosureRow, extractMarkdownPlainText, IconThinkOutline14, JsonBlock, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import { assistantCss as css, assistantStyleText } from './CodexAssistantStyles.ts'

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/** Render compact reasoning with a marker-free summary and Markdown body. */
export function CodexReasoningRow({ text, running, t }: {
  text: string
  running: boolean
  t: ChatViewSlotProps['t']
}) {
  const [expanded, setExpanded] = useState(false)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const summarySource = running ? latestLine(text) : firstLine(text)
  const summary = extractMarkdownPlainText(summarySource, { mode: 'first-line' })

  useEffect(() => {
    const element = summaryRef.current
    if (element === null) return
    const frame = requestAnimationFrame(() => {
      element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
    })
    return () => { cancelAnimationFrame(frame) }
  }, [running, summary])

  return (
    <div className={css.reasoning} data-state={running ? 'running' : 'ok'}>
      {running && <span className={css.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.reasoningRow}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title="Think"
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span ref={summaryRef} className={css.summary} data-follow-end={running || undefined}>{summary}</span>
          </>
        )}
      >
        <div className={css.thinkBody}>
          <MarkdownText text={text} streaming={running} />
        </div>
      </DisclosureRow>
    </div>
  )
}

function imageLabels(t: ChatViewSlotProps['t']): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: { dialog: t('image.preview'), close: t('image.closePreview') },
  }
}

interface AssistantBodyProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  interrupted?: boolean | undefined
  loadImage?: ImageLoader
  mentions?: MarkdownFileMentions | undefined
  t: ChatViewSlotProps['t']
}

/** Upstream-shaped block bridge, composed from public Harness UI primitives. */
export const CodexAssistantBody = memo(function CodexAssistantBody({
  blocks, streaming, interrupted, loadImage, mentions, t,
}: AssistantBodyProps) {
  const imageLoader = loadImage ?? (() => Promise.reject(new Error(t('image.serviceUnavailable'))))
  const codeLabels = useMemo(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t])
  const labels = useMemo(() => imageLabels(t), [t])
  const last = blocks.length - 1
  const hasVisible = streaming || interrupted === true || blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null

  const rendered: ReactNode[] = []
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        rendered.push(
          <MarkdownText
            key={i}
            text={block.text}
            streaming={streaming}
            codeLabels={codeLabels}
            fileMentions={mentions}
          />,
        )
        break
      case 'reasoning':
        rendered.push(<CodexReasoningRow key={i} text={block.text} running={streaming && i === last} t={t} />)
        break
      case 'image': {
        const start = i
        const group = [block]
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          i += 1
        }
        rendered.push(<ImageGallery key={start} images={group} load={imageLoader} align="start" labels={labels} />)
        break
      }
      case 'tool-call':
        break
      default:
        rendered.push(
          <JsonBlock
            key={i}
            label={t('message.unknownBlock')}
            payload={block.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />,
        )
    }
  }

  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
    </div>
  )
})

/** Register the bridge as a lower-priority shadow of Harness's built-in assistant cell. */
export function registerCodexAssistantRenderer(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshCodexAssistant = ''
    style.textContent = assistantStyleText
    document.head.append(style)
    return () => { style.remove() }
  }, 'dsh-openai-codex: assistant renderer styles')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    priority: -10,
    locale: 'conversation',
  }, CodexAssistantNodeView))
}

/** Slot-level bridge retaining Harness turn-tail mention behavior. */
export const CodexAssistantNodeView = memo(function CodexAssistantNodeView({
  node, useTurnData, openFile, loadImage, fileMentions, t,
}: ChatNodeViewProps<'assistant-step'>) {
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )

  return (
    <CodexAssistantBody
      blocks={data.blocks}
      streaming={data.status === 'running'}
      interrupted={data.status === 'interrupted'}
      loadImage={loadImage}
      mentions={mentions}
      t={t}
    />
  )
})
