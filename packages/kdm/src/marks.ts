/**
 * Marks on text (Standard 2.0 rule M19): rich-text run properties a `text` field declares in the
 * schema. Each mark key holds one value over ranges of characters.
 */
import { canonicalText, compareKeys } from './canonical'
import type { JsonValue } from './value'

/**
 * One run of a text field: characters that carry the same marks. `Replica.textDelta` reads a
 * text field as runs in order; adjacent runs differ in their marks, no run is empty, and
 * `attributes` holds only the field's declared marks, keys sorted, values in canonical form. A run
 * without marks has no `attributes`.
 */
export interface TextRun {
  insert: string
  attributes?: Record<string, JsonValue>
}

const sameAttributes = (a: Record<string, JsonValue> | undefined, b: Record<string, JsonValue> | undefined): boolean => {
  const left = a ? Object.keys(a).sort(compareKeys) : []
  const right = b ? Object.keys(b).sort(compareKeys) : []
  if (left.length !== right.length) return false
  return left.every((key, index) => key === right[index] && canonicalText(a![key]) === canonicalText(b![key]))
}

/** Appends a run, merging it into the last one when their marks are equal. */
export function pushRun(out: TextRun[], insert: string, attributes: Record<string, JsonValue> | undefined): void {
  if (insert === '') return
  const last = out[out.length - 1]
  if (last && sameAttributes(last.attributes, attributes)) {
    last.insert += insert
    return
  }
  out.push(attributes && Object.keys(attributes).length > 0 ? { insert, attributes } : { insert })
}
