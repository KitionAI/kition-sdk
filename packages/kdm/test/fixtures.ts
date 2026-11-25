/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { KdmError, parseSchema, type KdmErrorReason } from '../src/index'

/** A fixture the Rust crate writes and checks (`crates/kition-kdm/tests/fixtures/content/<name>`); never regenerated to make a test pass. */
export const contentFixture = (name: string): Uint8Array =>
  readFileSync(fileURLToPath(new URL(`../../../crates/kition-kdm/tests/fixtures/content/${name}`, import.meta.url)))

export const contentText = (name: string): string => new TextDecoder().decode(contentFixture(name))

/** The schema of the content fixtures (`kit.content`). */
export const contentSchema = () => parseSchema(contentText('schema.json'))

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** The reason of the `KdmError` `run` throws. */
export function reasonOf(run: () => unknown): KdmErrorReason {
  try {
    run()
  } catch (error) {
    if (error instanceof KdmError) return error.reason
    throw error
  }
  expect.unreachable('it did not throw')
  return 'engine'
}
