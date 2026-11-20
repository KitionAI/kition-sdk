/**
 * The person's review of the agent's headless draft of a file (KHP A13, A14; Kition's
 * `HeadlessDraftReview.tsx`): the structured comparison `GET /api/v1/kits/drafts/compare` answers
 * (objects created, changed field by field before and after, moved, deleted; texts; what was left
 * out when the draft changes more than the review lists; or why a kit without an object model
 * cannot be compared), the file now and with the draft as pictures, and Merge and Discard, which
 * only the person can press. A merge the gateway refuses as `stale` (the file changed since the
 * draft forked) says so and offers "Merge and overwrite" instead; nothing is overwritten without it.
 */
import type { Gateway } from './gateway'
import { GatewayError } from './gateway'
import { t } from './i18n'
import { h, toast } from './ui'

/** The headless draft of a file, as `GET /api/v1/kits/drafts` lists it. */
export type DraftListing = { path: string; kit?: string; state: 'open' | 'ready'; stale: boolean; updated?: number }

type Value = unknown
type Edit = { field?: string; named?: string; before?: Value; after?: Value }
type Entry = { id?: string; type?: string; fields?: string[]; edits?: Edit[]; from?: Value; to?: Value; values?: Record<string, Value> }
type Text = { id?: string; field?: string; before?: Value; after?: Value }
export type Comparison = {
  path: string
  kit: string
  state: string
  stale: boolean
  diff: { created?: Entry[]; changed?: Entry[]; moved?: Entry[]; deleted?: Entry[]; texts?: Text[]; truncated?: Record<string, number> } | null
  diffUnavailable?: string
  summary: { base?: string; draft?: string }
  previews?: { base?: string; draft?: string }
}

/** How many entries of each list the review shows before "and N more". */
const LISTED = 50

/** A value of a change as the review shows it: text as it is, `{excerpt, length}` as its excerpt, the rest as JSON. */
export function shown(value: Value): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && 'excerpt' in value) return String((value as { excerpt: unknown }).excerpt)
  return JSON.stringify(value)
}

function side(label: string, png: string | undefined, summary: string | undefined, testId: string) {
  const figure = h('figure', { class: 'side', 'data-testid': testId }, h('figcaption', {}, label))
  figure.append(png ? h('img', { src: `data:image/png;base64,${png}`, alt: label }) : h('div', { class: 'side__empty' }, t('noPreview')))
  if (summary) figure.append(h('p', { class: 'side__summary' }, summary))
  return figure
}

function entryRow(kind: 'created' | 'changed' | 'moved' | 'deleted', entry: Entry) {
  const label = { created: t('changeCreated'), changed: t('changeChanged'), moved: t('changeMoved'), deleted: t('changeDeleted') }[kind]
  const item = h('li', { class: 'change', 'data-change': kind, 'data-testid': `change-${kind}` }, h('span', { class: 'change__kind' }, label), h('span', { class: 'change__type' }, `${entry.type ?? ''} ${entry.id ?? ''}`.trim()))
  if (kind === 'changed' && entry.edits?.length) {
    const edits = h('ul', { class: 'edits' })
    for (const edit of entry.edits.slice(0, LISTED)) {
      edits.append(h('li', { 'data-testid': 'edit' }, h('code', { class: 'edit__field' }, edit.named ?? edit.field ?? ''), ' ', h('del', {}, shown(edit.before)), ' → ', h('ins', {}, shown(edit.after))))
    }
    item.append(edits)
  } else if (kind === 'changed' && entry.fields?.length) {
    item.append(h('span', { class: 'change__fields' }, entry.fields.join(', ')))
  } else if (kind === 'moved') {
    item.append(h('span', { class: 'change__fields' }, `${shown(entry.from)} → ${shown(entry.to)}`))
  } else if (kind === 'created' && entry.values) {
    item.append(h('span', { class: 'change__fields' }, Object.keys(entry.values).join(', ')))
  }
  return item
}

/** The comparison as the review shows it. */
export function renderComparison(comparison: Comparison) {
  const root = h('div', { class: 'comparison', 'data-testid': 'draft-comparison' })
  root.append(h('div', { class: 'sides' }, side(t('before'), comparison.previews?.base, comparison.summary?.base, 'draft-before'), side(t('after'), comparison.previews?.draft, comparison.summary?.draft, 'draft-after')))
  const diff = comparison.diff
  if (!diff) {
    root.append(h('p', { class: 'review__note', 'data-testid': 'draft-no-model' }, t('noModel', { reason: comparison.diffUnavailable ?? '' })))
    return root
  }
  const lists = ['created', 'changed', 'moved', 'deleted'] as const
  root.append(h('ul', { class: 'counts', 'data-testid': 'draft-counts' }, ...lists.map((kind) => h('li', {}, t(kind, { count: diff[kind]?.length ?? 0 })))))
  const rows = lists.flatMap((kind) => (diff[kind] ?? []).map((entry) => entryRow(kind, entry)))
  root.append(rows.length ? h('ul', { class: 'changes' }, ...rows.slice(0, LISTED * 4)) : h('p', { class: 'review__note' }, t('noChanges')))
  if (diff.texts?.length) {
    const texts = h('section', { class: 'texts', 'data-testid': 'draft-texts' }, h('h3', {}, t('texts')))
    for (const text of diff.texts.slice(0, LISTED)) texts.append(h('div', { class: 'text' }, h('del', {}, shown(text.before)), h('ins', {}, shown(text.after))))
    root.append(texts)
  }
  const truncated = Object.entries(diff.truncated ?? {}).filter(([, count]) => count > 0)
  if (truncated.length) root.append(h('p', { class: 'review__note', 'data-testid': 'draft-truncated' }, t('truncated', { what: truncated.map(([what, count]) => `${count} ${what}`).join(', ') })))
  return root
}

/**
 * The review of the draft of `path` in `container`; `onDone` hears a merge or a discard. `beforeMerge`
 * may refuse a merge (the editor has unsaved edits): it answers why.
 */
export function mountReview(gateway: Gateway, path: string, container: HTMLElement, hooks: { onDone: (outcome: 'merged' | 'discarded') => void; beforeMerge?: () => string | null }) {
  let current = true
  const body = h('div', { class: 'review__body', 'aria-live': 'polite' })
  const stale = h('p', { class: 'review__stale', role: 'alert', 'data-testid': 'draft-stale', hidden: true }, t('stale'))
  const merge = h('button', { type: 'button', class: 'button button--primary', 'data-testid': 'draft-merge', disabled: true }, t('merge'))
  const overwrite = h('button', { type: 'button', class: 'button button--danger', 'data-testid': 'draft-overwrite', hidden: true }, t('overwrite'))
  const discard = h('button', { type: 'button', class: 'button', 'data-testid': 'draft-discard', disabled: true }, t('discard'))
  const actions = h('div', { class: 'review__actions' }, discard, merge, overwrite)
  container.replaceChildren(h('div', { class: 'review', 'data-testid': 'draft-review' }, h('p', { class: 'review__hint' }, t('reviewHint')), stale, body, actions))
  const busy = (on: boolean) => {
    for (const button of [merge, overwrite, discard]) button.disabled = on
  }
  const showStale = () => {
    stale.hidden = false
    merge.hidden = true
    overwrite.hidden = false
  }
  const load = async () => {
    body.replaceChildren(h('p', { class: 'review__loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('comparing')))
    try {
      const comparison = await gateway.json<Comparison>(`api/v1/kits/drafts/compare?${new URLSearchParams({ path, previews: 'true' })}`)
      if (!current) return
      body.replaceChildren(renderComparison(comparison))
      busy(false)
      if (comparison.stale) showStale()
    } catch (error) {
      if (!current) return
      const missing = error instanceof GatewayError && error.status === 404
      body.replaceChildren(h('p', { class: 'review__failure', role: 'alert', 'data-testid': missing ? 'draft-none' : 'draft-compare-failed' }, missing ? t('noDraft', { name: path.split('/').pop() ?? path }) : `${t('compareFailed')}: ${(error as Error).message}`))
    }
  }
  const doMerge = async (overwriting: boolean) => {
    const refused = hooks.beforeMerge?.()
    if (refused) {
      toast(t('mergeFailed'), 'error', refused)
      return
    }
    busy(true)
    try {
      await gateway.send('api/v1/kits/drafts/merge', { path, overwrite: overwriting })
      toast(t('merged'), 'success')
      hooks.onDone('merged')
    } catch (error) {
      if (error instanceof GatewayError && error.reason === 'stale') showStale()
      else toast(t('mergeFailed'), 'error', (error as Error).message)
      busy(false)
    }
  }
  merge.addEventListener('click', () => void doMerge(false))
  overwrite.addEventListener('click', () => void doMerge(true))
  discard.addEventListener('click', async () => {
    busy(true)
    try {
      await gateway.send('api/v1/kits/drafts/discard', { path })
      toast(t('discarded'), 'info')
      hooks.onDone('discarded')
    } catch (error) {
      toast(t('discardFailed'), 'error', (error as Error).message)
      busy(false)
    }
  })
  void load()
  return {
    reload: () => void load(),
    close: () => {
      current = false
    },
  }
}
