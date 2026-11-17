/// <reference types="node" />
/**
 * Phase 1 measurements of the TypeScript KDM on the engine's WebAssembly build, the numbers a
 * page worker sees. Skipped by default: `KDM_BENCH=1 pnpm vitest run packages/kdm/bench`.
 */
import { it } from 'vitest'
import { newDocId, parseSchema, person, Replica, type Schema } from '../src/index'

const me = person('user:bench')
const imported = { kind: 'import' as const, principal: 'user:bench' }

const schemas = {
  slides: parseSchema({
    kdm: 1, kit: 'bench.slides', schemaVersion: 1, root: 'Slides',
    types: {
      Slides: { fields: { slides: { kind: 'list', of: 'Slide' } } },
      Slide: { fields: { hidden: { kind: 'boolean' }, shapes: { kind: 'list', of: 'Shape' }, notes: { kind: 'text' } } },
      Shape: { fields: { kind: { kind: 'enum', values: ['rect', 'text', 'picture'] }, transform: { kind: 'json' }, fill: { kind: 'string' }, text: { kind: 'text' } } },
    },
  }),
  table: parseSchema({
    kdm: 1, kit: 'bench.table', schemaVersion: 1, root: 'Table',
    types: {
      Table: { fields: { name: { kind: 'string' } } },
      Record: { fields: { name: { kind: 'string' }, email: { kind: 'string' }, stage: { kind: 'string' }, amount: { kind: 'string' }, owner: { kind: 'string' } } },
    },
  }),
  doc: parseSchema({ kdm: 1, kit: 'bench.doc', schemaVersion: 1, root: 'Doc', types: { Doc: { fields: { body: { kind: 'text' } } } } }),
}

function measure(name: string, schema: Schema, first: Replica, buildMs: number, edit: (replica: Replica, index: number) => void): string {
  const snapshot = first.snapshot()
  let start = performance.now()
  const second = Replica.load(schema, snapshot, 2n)
  const openMs = performance.now() - start
  const batches: Uint8Array[] = []
  for (let index = 0; index < 1000; index += 1) {
    const since = first.version()
    edit(first, index)
    batches.push(first.exportChanges(since))
  }
  start = performance.now()
  for (const batch of batches) second.importChanges(batch)
  const applyMs = performance.now() - start
  if (first.stateText() !== second.stateText()) throw new Error(`${name}: replicas differ`)
  return `| ${name} | ${buildMs.toFixed(0)} | ${Math.round(snapshot.length / 1024)} | ${openMs.toFixed(1)} | ${applyMs.toFixed(1)} |`
}

function slides(): string {
  const start = performance.now()
  const { replica, result: shapes } = Replica.createWith(schemas.slides, newDocId(), 1n, imported, (tx) => {
    const slides = tx.create('Slides', {})
    const shapes: string[] = []
    for (let s = 0; s < 500; s += 1) {
      const slide = tx.create('Slide', { hidden: false })
      tx.listInsert(slides, 'slides', s, slide)
      for (let k = 0; k < 20; k += 1) {
        const shape = tx.create('Shape', { kind: 'text', transform: { x: k * 10, y: k * 5, w: 200, h: 40 }, fill: '#ffffff' })
        tx.textInsert(shape, 'text', 0, 'Quarterly review 季度回顾')
        tx.listInsert(slide, 'shapes', k, shape)
        shapes.push(shape)
      }
    }
    return shapes
  })
  return measure('Slides: 500 slides × 20 shapes with text', schemas.slides, replica, performance.now() - start, (r, i) =>
    r.transact(me, (tx) => tx.set(shapes[(i * 7) % shapes.length], 'fill', `#${i.toString(16).padStart(6, '0')}`)),
  )
}

function table(): string {
  const start = performance.now()
  const { replica, result: records } = Replica.createWith(schemas.table, newDocId(), 1n, imported, (tx) => {
    tx.create('Table', { name: 'Leads' })
    const records: string[] = []
    for (let row = 0; row < 100_000; row += 1) {
      records.push(tx.create('Record', { name: `name ${row}`, email: `email ${row}`, stage: `stage ${row}`, amount: `amount ${row}`, owner: `owner ${row}` }))
    }
    return records
  })
  return measure('Table: 100,000 records × 5 fields (one object per record)', schemas.table, replica, performance.now() - start, (r, i) =>
    r.transact(me, (tx) => tx.set(records[(i * 97) % records.length], 'stage', 'won')),
  )
}

function text(): string {
  const start = performance.now()
  const replica = Replica.create(schemas.doc, newDocId(), 1n)
  const doc = replica.transact(me, (tx) => tx.create('Doc', {}))
  for (let paragraph = 0; paragraph < 2000; paragraph += 1) {
    replica.transact(me, (tx) => tx.textInsert(doc, 'body', tx.textLength(doc, 'body'), `Paragraph ${paragraph}: 中文混排 text with emoji 😀 and more words.\n`))
  }
  return measure('Text: 2,000 paragraphs typed one transaction each', schemas.doc, replica, performance.now() - start, (r, i) =>
    r.transact(me, (tx) => {
      const body = r.text(doc, 'body')
      let at = (i * 31) % 1000
      if (/[\uDC00-\uDFFF]/.test(body[at] ?? '')) at -= 1
      tx.textInsert(doc, 'body', at, 'x')
    }),
  )
}

it.skipIf(!process.env.KDM_BENCH)('reports the phase 1 measurements', () => {
  const rows = [slides(), table(), text()]
  console.log(['| Case | Build (ms) | Snapshot (KB) | Open snapshot (ms) | Apply 1,000 remote edits (ms) |', '| --- | ---: | ---: | ---: | ---: |', ...rows].join('\n'))
  console.log(`Heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB, array buffers (WebAssembly memory) ${Math.round(process.memoryUsage().arrayBuffers / 1048576)} MB`)
}, 600_000)
