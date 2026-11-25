/**
 * A text field: its characters as runs that carry the same marks (rule M19), as the Rust store
 * holds it. Positions count Unicode scalar values (code points), as in the changes Rust writes;
 * readers that answer UTF-16 convert.
 */
import { canonicalText, compareKeys, setKey } from './canonical'
import type { Expand } from './schema'
import type { JsonValue } from './value'

/** A run's marks: mark key to value, never `null`, keys sorted. */
export type Marks = Record<string, JsonValue>

/** Characters that carry the same marks; `len` counts code points. */
type Run = { text: string; len: number; marks: Marks; key: string }

/** A range of characters and the value one mark key held over it (`null`: none). */
export type MarkSegment = [number, number, JsonValue]

/** The number of code points of `text`. */
export function codePoints(text: string): number {
  let count = text.length
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        count -= 1
        index += 1
      }
    }
  }
  return count
}

/** The UTF-16 offset of code point `index` in `text` (which has `len` code points). */
function unitAt(text: string, len: number, index: number): number {
  if (len === text.length) return Math.min(index, text.length)
  let at = 0
  for (let point = 0; point < index && at < text.length; point += 1) {
    const unit = text.charCodeAt(at)
    const next = text.charCodeAt(at + 1)
    at += unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1
  }
  return at
}

/** `marks` with keys sorted and `null` values dropped. */
export function sortedMarks(marks: Record<string, JsonValue>): Marks {
  const out: Marks = {}
  for (const key of Object.keys(marks).sort(compareKeys)) {
    if (marks[key] !== null && marks[key] !== undefined) setKey(out, key, marks[key])
  }
  return out
}

const run = (text: string, len: number, marks: Marks, key?: string): Run => ({ text, len, marks, key: key ?? canonicalText(marks) })

export class Text {
  private runs: Run[] = []
  private length = 0

  /** Its length in code points. */
  get len(): number {
    return this.length
  }

  isEmpty(): boolean {
    return this.length === 0
  }

  string(): string {
    return this.runs.map((each) => each.text).join('')
  }

  hasMarks(): boolean {
    return this.runs.some((each) => each.key !== '{}')
  }

  /** The runs in order: `[text, marks]`, adjacent runs with different marks, none empty. */
  pieces(): Array<{ insert: string; attributes: Marks }> {
    return this.runs.map((each) => ({ insert: each.text, attributes: each.marks }))
  }

  /** The marks of the character at `index`, or `null` past the end. */
  private marksAt(index: number): Marks | null {
    let at = 0
    for (const each of this.runs) {
      if (index < at + each.len) return each.marks
      at += each.len
    }
    return null
  }

  /**
   * The marks text inserted at `index` takes from its neighbours (the Rust `inserted_marks`): a
   * key the character before holds when its expand is `after` or `both`, or when the character
   * after holds the same value; else a key the character after holds when its expand is `before`
   * or `both`.
   */
  insertedMarks(index: number, expand: (key: string) => Expand | undefined): Marks {
    const left = index > 0 ? this.marksAt(index - 1) : null
    const right = index < this.length ? this.marksAt(index) : null
    const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])
    const out: Marks = {}
    for (const key of [...keys].sort(compareKeys)) {
      const grows = expand(key) ?? 'none'
      const l = left && Object.hasOwn(left, key) ? left[key] : undefined
      const r = right && Object.hasOwn(right, key) ? right[key] : undefined
      if (l !== undefined && (grows === 'after' || grows === 'both' || (r !== undefined && canonicalText(r) === canonicalText(l)))) setKey(out, key, l)
      else if (r !== undefined && (grows === 'before' || grows === 'both')) setKey(out, key, r)
    }
    return out
  }

  /** Makes a run boundary at `index`; answers the number of the run that starts there. */
  private split(index: number): number {
    let at = 0
    for (let number = 0; number < this.runs.length; number += 1) {
      const each = this.runs[number]
      if (index === at) return number
      if (index < at + each.len) {
        const cut = unitAt(each.text, each.len, index - at)
        const head = run(each.text.slice(0, cut), index - at, each.marks, each.key)
        const tail = run(each.text.slice(cut), each.len - (index - at), each.marks, each.key)
        this.runs.splice(number, 1, head, tail)
        return number + 1
      }
      at += each.len
    }
    return this.runs.length
  }

  /** Drops empty runs and merges adjacent runs with equal marks. */
  private normalize(): void {
    const merged: Run[] = []
    for (const each of this.runs) {
      if (each.len === 0) continue
      const last = merged[merged.length - 1]
      if (last && last.key === each.key) merged[merged.length - 1] = run(last.text + each.text, last.len + each.len, last.marks, last.key)
      else merged.push(each)
    }
    this.runs = merged
  }

  /** Inserts `content` at `index` (at most the length) with `marks`. */
  insert(index: number, content: string, marks: Marks): void {
    const count = codePoints(content)
    if (count === 0) return
    const at = this.split(Math.min(index, this.length))
    this.runs.splice(at, 0, run(content, count, sortedMarks(marks)))
    this.length += count
    this.normalize()
  }

  /** Deletes `count` characters from `index`; answers them as runs. */
  delete(index: number, count: number): Array<{ insert: string; attributes: Marks }> {
    const end = Math.min(index + count, this.length)
    if (index >= end) return []
    const first = this.split(index)
    const last = this.split(end)
    const removed = this.runs.splice(first, last - first)
    this.length -= end - index
    this.normalize()
    return removed.map((each) => ({ insert: each.text, attributes: each.marks }))
  }

  /**
   * Sets mark `key` to `value` over `start..end` (`null`: removes it). Answers what the key held
   * over the range before, as consecutive segments with their values (`null`: none).
   */
  mark(start: number, end: number, key: string, value: JsonValue): MarkSegment[] {
    end = Math.min(end, this.length)
    if (start >= end) return []
    const first = this.split(start)
    const last = this.split(end)
    const before: MarkSegment[] = []
    let at = start
    for (let number = first; number < last; number += 1) {
      const each = this.runs[number]
      const held = Object.hasOwn(each.marks, key) ? each.marks[key] : null
      const previous = before[before.length - 1]
      if (previous && canonicalText(previous[2]) === canonicalText(held)) previous[1] = at + each.len
      else before.push([at, at + each.len, held])
      at += each.len
      const marks: Marks = { ...each.marks }
      if (value === null) delete marks[key]
      else setKey(marks, key, value)
      const sorted = sortedMarks(marks)
      this.runs[number] = run(each.text, each.len, sorted)
    }
    this.normalize()
    return before
  }
}
