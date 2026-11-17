// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommentThread } from '@kition/kdm'
import { CommentsPanel, type CommentsPanelProps } from './CommentsPanel'
import { commentMarkers } from './useCommentAnchors'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
})

function render(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(node))
}

const threads: CommentThread[] = [
  {
    id: 't1',
    anchor: { object: 'shape-1' },
    resolved: false,
    comments: [
      { id: 'c1', author: 'u:alice', name: 'Alice', body: 'Is this right?', created: '2026-10-19T10:00:00Z' },
      { id: 'c2', author: 'u:bob', name: 'Bob', body: 'Yes.', created: '2026-10-19T10:01:00Z' },
    ],
  },
  { id: 't2', anchor: { object: 'gone' }, resolved: true, comments: [{ id: 'c3', author: 'u:bob', name: 'Bob', body: 'Done', created: '2026-10-19T11:00:00Z' }] },
]

function panel(overrides: Partial<CommentsPanelProps> = {}) {
  const props: CommentsPanelProps = {
    threads,
    me: 'u:bob',
    canComment: true,
    onAdd: vi.fn(),
    onReply: vi.fn(),
    onResolve: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
  render(<CommentsPanel {...props} />)
  return props
}

const all = (testId: string) => [...container.querySelectorAll(`[data-testid="${testId}"]`)] as HTMLElement[]

function type(field: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('CommentsPanel', () => {
  it('lists threads with their comments, naming this person "You"', () => {
    panel()
    expect(all('kit-comments-thread').map((thread) => thread.dataset.resolved)).toEqual(['false', 'true'])
    const texts = all('kit-comments-comment').map((comment) => comment.textContent ?? '')
    expect(texts[0]).toMatch(/^Alice.*Is this right\?$/)
    expect(texts[1]).toMatch(/^You.*Yes\.$/)
    expect(texts[2]).toMatch(/^You.*Done$/)
  })

  it('replies, resolves, and deletes only this person’s own comments', () => {
    const props = panel()
    // One delete button per own comment: c2 and c3.
    expect(all('kit-comments-delete')).toHaveLength(2)
    act(() => all('kit-comments-delete')[0].click())
    expect(props.onDelete).toHaveBeenCalledWith('t1', 'c2')
    act(() => all('kit-comments-resolve')[0].click())
    expect(props.onResolve).toHaveBeenCalledWith('t1', true)
    act(() => all('kit-comments-resolve')[1].click())
    expect(props.onResolve).toHaveBeenCalledWith('t2', false)
    // A resolved thread takes no replies.
    expect(all('kit-comments-reply')).toHaveLength(1)
    type(all('kit-comments-reply-input')[0] as HTMLTextAreaElement, '  Thanks  ')
    act(() => all('kit-comments-reply-send')[0].click())
    expect(props.onReply).toHaveBeenCalledWith('t1', 'Thanks')
  })

  it('opens a new thread at the pending anchor', () => {
    const anchor = { object: 'shape-2' }
    const onCancelNew = vi.fn()
    const props = panel({ pendingAnchor: anchor, onCancelNew, anchorLabel: (at) => `On ${at.object}` })
    expect(container.textContent).toContain('On shape-2')
    const send = all('kit-comments-new-send')[0] as HTMLButtonElement
    expect(send.disabled).toBe(true)
    type(all('kit-comments-new-input')[0] as HTMLTextAreaElement, 'Look here')
    act(() => send.click())
    expect(props.onAdd).toHaveBeenCalledWith(anchor, 'Look here')
  })

  it('writes nothing without the right to comment', () => {
    panel({ canComment: false, pendingAnchor: { object: 'x' } })
    expect(all('kit-comments-new')).toHaveLength(0)
    expect(all('kit-comments-reply')).toHaveLength(0)
    expect(all('kit-comments-resolve')).toHaveLength(0)
    expect(all('kit-comments-delete')).toHaveLength(0)
  })

  it('shows others’ threads as read-only history without co-editing, but keeps this person’s own', () => {
    panel({ othersReadOnly: true })
    // Alice opened t1: history. Bob opened t2: his own, still resolvable.
    expect(all('kit-comments-history')).toHaveLength(1)
    expect(all('kit-comments-thread')[0].querySelector('[data-testid="kit-comments-resolve"]')).toBeNull()
    expect(all('kit-comments-thread')[0].querySelector('[data-testid="kit-comments-delete"]')).toBeNull()
    expect(all('kit-comments-thread')[1].querySelector('[data-testid="kit-comments-resolve"]')).not.toBeNull()
  })
})

describe('commentMarkers', () => {
  it('places open threads whose anchor is shown, and marks the active one', () => {
    const locate = (anchor: { object: string }) => (anchor.object === 'gone' ? null : { x: 1, y: 2, width: 3, height: 4 })
    expect(commentMarkers({ threads, locate, activeThread: 't1' })).toEqual([
      { thread: 't1', anchor: { object: 'shape-1' }, rect: { x: 1, y: 2, width: 3, height: 4 }, resolved: false, count: 2, active: true },
    ])
    // Resolved threads only when asked; one whose anchor is gone never.
    expect(commentMarkers({ threads, locate, showResolved: true })).toHaveLength(1)
    expect(commentMarkers({ threads, locate: () => ({ x: 0, y: 0, width: 0, height: 0 }), showResolved: true }).map((marker) => marker.thread)).toEqual(['t1', 't2'])
  })
})
