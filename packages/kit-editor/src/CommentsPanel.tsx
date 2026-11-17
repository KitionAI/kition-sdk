/**
 * Comment threads in a kit's editor (KitModel rule M23): a side panel that lists a
 * document's threads (`commentThreads` from `@kition/kdm`), opens a new one at an anchor the kit
 * chose, and replies to, resolves, reopens, and deletes them. The panel only shows and asks; the
 * kit writes every change as a transaction (`addThread`, `reply`, `setResolved`, `deleteComment`).
 *
 * Who may do what:
 * - `canComment` false (a viewer, a read-only file): threads are shown, nothing can be written.
 * - `othersReadOnly` (no co-editing session, rule M23): threads others opened are read-only
 *   history; the person may still open, reply to, and resolve their own.
 * - A comment can be deleted only by its author.
 *
 * Styled with the Kit UI theme tokens; strings come from the kit (`labels`), English by default.
 */
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { CheckIcon as Check, MessageSquareIcon as MessageSquare, RotateCcwIcon as RotateCcw, TrashIcon as Trash2 } from '@kition/tessera-icons/react'
import type { CommentAnchor, CommentThread } from '@kition/kdm'
import { Button, ICON_STROKE, IconButton } from '@kition/tessera-ui'

export type CommentsPanelLabels = {
  title: string
  empty: string
  newComment: string
  placeholder: string
  replyPlaceholder: string
  comment: string
  reply: string
  cancel: string
  resolve: string
  reopen: string
  delete: string
  resolved: string
  readOnlyHistory: string
  you: string
}

export const COMMENTS_PANEL_LABELS: CommentsPanelLabels = {
  title: 'Comments',
  empty: 'No comments yet.',
  newComment: 'New comment',
  placeholder: 'Add a comment…',
  replyPlaceholder: 'Reply…',
  comment: 'Comment',
  reply: 'Reply',
  cancel: 'Cancel',
  resolve: 'Resolve',
  reopen: 'Reopen',
  delete: 'Delete',
  resolved: 'Resolved',
  readOnlyHistory: 'Shared comment: read-only without co-editing',
  you: 'You',
}

export type CommentsPanelProps = {
  threads: CommentThread[]
  /** This person's principal id (the `author` of what they write); `null` when unknown. */
  me: string | null
  /** Whether this person may write comments at all. */
  canComment: boolean
  /** Threads others opened are read-only history (no co-editing session). */
  othersReadOnly?: boolean
  /** Where a new thread would go; set, the panel shows its composer first. */
  pendingAnchor?: CommentAnchor | null
  /** The thread the kit highlights (its anchor was clicked); the panel scrolls to it. */
  activeThread?: string | null
  onActivate?: (thread: string) => void
  onAdd: (anchor: CommentAnchor, body: string) => void
  onCancelNew?: () => void
  onReply: (thread: string, body: string) => void
  onResolve: (thread: string, resolved: boolean) => void
  onDelete: (thread: string, comment: string) => void
  /** What the thread's anchor points at, to show above it ("Slide 2", a quote). */
  anchorLabel?: (anchor: CommentAnchor) => string | null
  /** When a comment was written, for people; ISO text by default. */
  formatTime?: (created: string) => string
  labels?: Partial<CommentsPanelLabels>
  testId?: string
}

const styles = {
  panel: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, overflow: 'auto', minHeight: 0, color: 'var(--kit-text)', fontFamily: 'var(--kit-font-sans)', fontSize: 13 },
  header: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 },
  card: { border: '1px solid var(--kit-border)', borderRadius: 'var(--kit-radius-card, 12px)', background: 'var(--kit-surface)', boxShadow: 'var(--kit-shadow-card)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  active: { borderColor: 'var(--kit-primary)' },
  muted: { color: 'var(--kit-text-muted)', fontSize: 12 },
  comment: { display: 'flex', flexDirection: 'column', gap: 2 },
  byline: { display: 'flex', alignItems: 'center', gap: 6 },
  author: { fontWeight: 600 },
  body: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  actions: { display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 56,
    resize: 'vertical',
    border: '1px solid var(--kit-border)',
    borderRadius: 'var(--kit-radius-control, 8px)',
    background: 'var(--kit-surface)',
    color: 'var(--kit-text)',
    font: 'inherit',
    padding: 6,
  },
} satisfies Record<string, CSSProperties>

function Composer({ placeholder, submit, cancel, labels, autoFocus, testId }: { placeholder: string; submit: (body: string) => void; cancel?: () => void; labels: CommentsPanelLabels; autoFocus?: boolean; testId: string }) {
  const [body, setBody] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) field.current?.focus()
  }, [autoFocus])
  const send = (event?: FormEvent) => {
    event?.preventDefault()
    const text = body.trim()
    if (!text) return
    submit(text)
    setBody('')
  }
  return (
    <form onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={testId}>
      <textarea
        ref={field}
        value={body}
        placeholder={placeholder}
        aria-label={placeholder}
        style={styles.input}
        data-testid={`${testId}-input`}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
          if (event.key === 'Escape' && cancel) cancel()
        }}
      />
      <div style={styles.actions}>
        {cancel ? <Button onClick={cancel}>{labels.cancel}</Button> : null}
        <Button type="submit" variant="primary" disabled={!body.trim()} data-testid={`${testId}-send`}>
          {placeholder === labels.replyPlaceholder ? labels.reply : labels.comment}
        </Button>
      </div>
    </form>
  )
}

/** The comments side panel: the threads, newest activity last, and a composer for new ones. */
export function CommentsPanel(props: CommentsPanelProps) {
  const labels = { ...COMMENTS_PANEL_LABELS, ...props.labels }
  const testId = props.testId ?? 'kit-comments'
  const { me, canComment, othersReadOnly = false } = props
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!props.activeThread) return
    list.current?.querySelector(`[data-thread="${CSS.escape(props.activeThread)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [props.activeThread])
  const time = props.formatTime ?? ((created: string) => created.replace('T', ' ').replace(/(:\d\d)(\.\d+)?Z$/, '$1'))
  const authorName = (author: string, name?: string) => (me !== null && author === me ? labels.you : name || author)
  return (
    <div style={styles.panel} data-testid={testId} ref={list}>
      <div style={styles.header}>
        <MessageSquare size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span>{labels.title}</span>
      </div>
      {props.pendingAnchor && canComment ? (
        <div style={styles.card}>
          {props.anchorLabel?.(props.pendingAnchor) ? <div style={styles.muted}>{props.anchorLabel(props.pendingAnchor)}</div> : null}
          <Composer
            placeholder={labels.placeholder}
            labels={labels}
            autoFocus
            testId={`${testId}-new`}
            submit={(body) => props.onAdd(props.pendingAnchor!, body)}
            cancel={props.onCancelNew}
          />
        </div>
      ) : null}
      {props.threads.length === 0 && !props.pendingAnchor ? <div style={styles.muted}>{labels.empty}</div> : null}
      {props.threads.map((thread) => {
        const opener = thread.comments[0]?.author
        const mine = me !== null && opener === me
        const writable = canComment && (!othersReadOnly || mine)
        const anchor = thread.anchor && props.anchorLabel ? props.anchorLabel(thread.anchor) : null
        return (
          <div
            key={thread.id}
            data-thread={thread.id}
            data-testid={`${testId}-thread`}
            data-resolved={thread.resolved ? 'true' : 'false'}
            style={{ ...styles.card, ...(props.activeThread === thread.id ? styles.active : {}), ...(thread.resolved ? { opacity: 0.75 } : {}) }}
            onClick={() => props.onActivate?.(thread.id)}
          >
            {anchor ? <div style={styles.muted}>{anchor}</div> : null}
            {thread.comments.map((comment) => (
              <div key={comment.id} style={styles.comment} data-testid={`${testId}-comment`} data-author={comment.author}>
                <div style={styles.byline}>
                  <span style={styles.author}>{authorName(comment.author, comment.name)}</span>
                  <span style={styles.muted}>{time(comment.created)}</span>
                  <span style={{ flex: 1 }} />
                  {writable && comment.author === me ? (
                    <IconButton icon={Trash2} label={labels.delete} data-testid={`${testId}-delete`} onClick={(event) => {
                      event.stopPropagation()
                      props.onDelete(thread.id, comment.id)
                    }} />
                  ) : null}
                </div>
                <div style={styles.body}>{comment.body}</div>
              </div>
            ))}
            <div style={styles.actions}>
              {thread.resolved ? <span style={{ ...styles.muted, marginRight: 'auto' }}>{labels.resolved}</span> : null}
              {!writable && othersReadOnly && !mine ? <span style={{ ...styles.muted, marginRight: 'auto' }} data-testid={`${testId}-history`}>{labels.readOnlyHistory}</span> : null}
              {writable ? (
                <IconButton
                  icon={thread.resolved ? RotateCcw : Check}
                  label={thread.resolved ? labels.reopen : labels.resolve}
                  data-testid={`${testId}-resolve`}
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onResolve(thread.id, !thread.resolved)
                  }}
                />
              ) : null}
            </div>
            {writable && !thread.resolved ? <Composer placeholder={labels.replyPlaceholder} labels={labels} testId={`${testId}-reply`} submit={(body) => props.onReply(thread.id, body)} /> : null}
          </div>
        )
      })}
    </div>
  )
}
