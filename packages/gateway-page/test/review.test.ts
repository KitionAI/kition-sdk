// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderComparison, shown, type Comparison } from '../src/page/review'

const base: Comparison = { path: 'a.ktable', kit: 'kit.table', state: 'ready', stale: false, diff: null, summary: { base: 'one row', draft: 'two rows' }, previews: { base: 'iVBOR', draft: 'iVBOR' } }

describe('the gateway page: the draft review', () => {
  it('shows each change: created, changed field by field before and after, moved, deleted, texts, and what was left out', () => {
    const view = renderComparison({
      ...base,
      diff: {
        created: [{ id: 'row:3', type: 'Row', values: { title: 'New' } }],
        changed: [{ id: 'cell:A1', type: 'Cell', edits: [{ field: 'value', before: 'Plan', after: 'Plan B' }, { field: 'note', before: { excerpt: 'long…', length: 900 }, after: 2 }] }],
        moved: [{ id: 'row:2', type: 'Row', from: { index: 1 }, to: { index: 0 } }],
        deleted: [{ id: 'row:9', type: 'Row' }],
        texts: [{ id: 'cell:A1', field: 'value', before: 'Plan', after: 'Plan B' }],
        truncated: { created: 3, edits: 0 },
      },
    })
    expect(view.querySelector('[data-testid="draft-counts"]')?.textContent).toContain('1 created')
    const edits = [...view.querySelectorAll('[data-testid="edit"]')].map((edit) => edit.textContent)
    expect(edits).toEqual(['value Plan → Plan B', 'note long… → 2'])
    expect(view.querySelector('[data-change="moved"]')?.textContent).toContain('{"index":1} → {"index":0}')
    expect(view.querySelector('[data-change="deleted"]')?.textContent).toContain('Row row:9')
    expect(view.querySelector('[data-testid="draft-truncated"]')?.textContent).toContain('3 created')
    expect(view.querySelectorAll('img')).toHaveLength(2)
    expect(view.querySelector('[data-testid="draft-before"]')?.textContent).toContain('one row')
  })

  it('says why a kit without an object model is compared by its pictures', () => {
    const view = renderComparison({ ...base, previews: {}, diffUnavailable: 'a copy of the file has no replica history to compare' })
    expect(view.querySelector('[data-testid="draft-no-model"]')?.textContent).toContain('no replica history')
    expect(view.querySelectorAll('img')).toHaveLength(0)
    expect(shown(undefined)).toBe('—')
  })
})
