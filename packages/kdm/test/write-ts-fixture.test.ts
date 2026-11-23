/// <reference types="node" />
/**
 * Writes the TypeScript-made fixture the Rust crate reads in `tests/cross_language.rs`:
 *
 *     KDM_WRITE_FIXTURE=1 pnpm vitest run packages/kdm/test/write-ts-fixture.test.ts
 *
 * and the shallow one (`ts-shallow.*`) with `KDM_WRITE_SHALLOW_FIXTURE=1` instead, or the committed
 * `ts-page.bin` copied as a new document (`ts-new-document.*`, docId
 * `01920000-0000-7000-8000-0000000000ab`) with `KDM_WRITE_NEW_DOCUMENT_FIXTURE=1`, or the committed
 * `ts-new-document.bin` (a shallow replica) with its page retitled, as it answers every change
 * (`ts-shallow-export.*`, `exportChanges(Version.empty())`), with `KDM_WRITE_SHALLOW_EXPORT_FIXTURE=1`,
 * or the committed `ts-page.bin` copied as a new document (docId `01920000-0000-7000-8000-0000000000ac`)
 * with its page retitled, as its snapshot (`ts-birth.bin`, rooted at its birth) and as a shallow
 * snapshot at its last version (`ts-birth-truncated.bin`), with `KDM_WRITE_BIRTH_FIXTURE=1`, or the
 * committed `ts-page.bin` edited by two replicas (text typed and deleted, a title overwritten),
 * merged, as its content snapshot (`ts-content.*`, `contentSnapshot()`), with
 * `KDM_WRITE_CONTENT_FIXTURE=1`.
 *
 * Skipped otherwise, so the committed fixture changes only on purpose (object ids are new each time).
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { agent, person, Replica, Version } from '../src/index'
import { testSchema, tsPage, tsShallow } from './helpers'

const target = (name: string) => fileURLToPath(new URL(`../../../crates/kition-kdm/tests/fixtures/${name}`, import.meta.url))

it.skipIf(!process.env.KDM_WRITE_FIXTURE)('writes crates/kition-kdm/tests/fixtures/ts-page.{bin,json,sha256}', () => {
  const doc = tsPage()
  writeFileSync(target('ts-page.bin'), doc.snapshot())
  writeFileSync(target('ts-page.json'), doc.stateText())
  writeFileSync(target('ts-page.sha256'), createHash('sha256').update(doc.stateText()).digest('hex'))
})

it.skipIf(!process.env.KDM_WRITE_SHALLOW_FIXTURE)('writes crates/kition-kdm/tests/fixtures/ts-shallow.{bin,json,sha256}', () => {
  const { replica, bytes } = tsShallow()
  writeFileSync(target('ts-shallow.bin'), bytes)
  writeFileSync(target('ts-shallow.json'), replica.stateText())
  writeFileSync(target('ts-shallow.sha256'), createHash('sha256').update(replica.stateText()).digest('hex'))
})

it.skipIf(!process.env.KDM_WRITE_NEW_DOCUMENT_FIXTURE)('writes crates/kition-kdm/tests/fixtures/ts-new-document.{bin,json,sha256}', () => {
  const copy = Replica.load(testSchema(), readFileSync(target('ts-page.bin')), 3n).copyAsNewDocument('01920000-0000-7000-8000-0000000000ab', 4n)
  writeFileSync(target('ts-new-document.bin'), copy.snapshot())
  writeFileSync(target('ts-new-document.json'), copy.stateText())
  writeFileSync(target('ts-new-document.sha256'), createHash('sha256').update(copy.stateText()).digest('hex'))
})

it.skipIf(!process.env.KDM_WRITE_SHALLOW_EXPORT_FIXTURE)('writes crates/kition-kdm/tests/fixtures/ts-shallow-export.{bin,json,sha256}', () => {
  const copy = Replica.load(testSchema(), readFileSync(target('ts-new-document.bin')), 5n)
  const page = copy.objectsOfType('Page')[0] as string
  copy.transact(person('user:fixture'), (tx) => tx.set(page, 'title', 'Forked page'))
  writeFileSync(target('ts-shallow-export.bin'), copy.exportChanges(Version.empty()))
  writeFileSync(target('ts-shallow-export.json'), copy.stateText())
  writeFileSync(target('ts-shallow-export.sha256'), createHash('sha256').update(copy.stateText()).digest('hex'))
})

it.skipIf(!process.env.KDM_WRITE_BIRTH_FIXTURE)('writes crates/kition-kdm/tests/fixtures/ts-birth.bin and ts-birth-truncated.bin', () => {
  const copy = Replica.load(testSchema(), readFileSync(target('ts-page.bin')), 3n).copyAsNewDocument('01920000-0000-7000-8000-0000000000ac', 6n)
  const page = copy.objectsOfType('Page')[0] as string
  copy.transact(person('user:fixture'), (tx) => tx.set(page, 'title', 'Born page'))
  writeFileSync(target('ts-birth.bin'), copy.snapshot())
  writeFileSync(target('ts-birth-truncated.bin'), copy.shallowSnapshot(copy.version()))
})

it.skipIf(!process.env.KDM_WRITE_CONTENT_FIXTURE)('writes crates/kition-kdm/tests/fixtures/ts-content.{bin,json,sha256}', () => {
  const a = Replica.load(testSchema(), readFileSync(target('ts-page.bin')), 11n)
  const b = Replica.load(testSchema(), a.snapshot(), 12n)
  const page = a.objectsOfType('Page')[0] as string
  const shape = a.objectsOfType('Shape')[0] as string
  a.transact(person('user:Hs6Pn2Dc9Lx', 'Ty5Ga1Ve7Oj'), (tx) => tx.textInsert(shape, 'label', 0, 'Jx4Hb8Ty3Nc6'))
  a.transact(person('user:Hs6Pn2Dc9Lx', 'Ty5Ga1Ve7Oj'), (tx) => tx.textDelete(shape, 'label', 0, 12))
  b.transact(agent('agent:Mz8Cu4Ki0Ef', 'Rb2Wn6Xs3Ip'), (tx) => tx.set(page, 'title', 'Ug5Le1Fo0Dw4'))
  b.transact(agent('agent:Mz8Cu4Ki0Ef', 'Rb2Wn6Xs3Ip'), (tx) => tx.set(page, 'title', 'Content page'))
  a.importChanges(b.exportChanges(a.version()))
  writeFileSync(target('ts-content.bin'), a.contentSnapshot())
  writeFileSync(target('ts-content.json'), a.stateText())
  writeFileSync(target('ts-content.sha256'), createHash('sha256').update(a.stateText()).digest('hex'))
})
