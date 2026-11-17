/// <reference types="node" />
/**
 * Writes the TypeScript-made fixture the Rust crate reads in `tests/cross_language.rs`:
 *
 *     KDM_WRITE_FIXTURE=1 pnpm vitest run packages/kdm/test/write-ts-fixture.test.ts
 *
 * and the shallow one (`ts-shallow.*`) with `KDM_WRITE_SHALLOW_FIXTURE=1` instead.
 *
 * Skipped otherwise, so the committed fixture changes only on purpose (object ids are new each time).
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { tsPage, tsShallow } from './helpers'

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
