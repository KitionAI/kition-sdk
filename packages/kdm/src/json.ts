/**
 * A strict JSON reader for the bytes the Rust KDM writes (content, snapshots, change lists):
 * UTF-8 without a byte order mark, a key named twice in one object refused (`JSON.parse` would
 * keep the last), an integer beyond ±2^53 refused (JavaScript would round it), and a number beyond
 * the double range refused, and arrays and objects nested deeper than 127 levels refused (rule
 * C14). Every refusal is an `encoding` error.
 */
import { setKey } from './canonical'
import { errors } from './errors'
import type { JsonValue } from './value'

const SAFE = 2 ** 53
const SAFE_BIG = 2n ** 53n
/** The deepest nesting of arrays and objects, the outer value counted as 1 (rule C14; serde_json's recursion limit). */
const MAX_DEPTH = 127

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The bytes as UTF-8 text; refuses invalid UTF-8 and a byte order mark. */
export function utf8(bytes: Uint8Array, what: string): string {
  let text: string
  try {
    text = DECODER.decode(bytes)
  } catch {
    throw errors.encoding(`${what}: not UTF-8`)
  }
  if (text.charCodeAt(0) === 0xfeff) throw errors.encoding(`${what}: a byte order mark`)
  return text
}

/** Parses one JSON value (`what` names the bytes in messages). */
export function parseJson(text: string, what: string): JsonValue {
  let at = 0
  const fail = (reason: string): never => {
    throw errors.encoding(`${what}: ${reason} at character ${at}`)
  }
  const space = () => {
    for (;;) {
      const code = text.charCodeAt(at)
      if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) at += 1
      else return
    }
  }
  const string = (): string => {
    // at is on the opening quote
    at += 1
    let out = ''
    let start = at
    for (;;) {
      if (at >= text.length) fail('an unterminated string')
      const code = text.charCodeAt(at)
      if (code === 0x22) {
        out += text.slice(start, at)
        at += 1
        return out
      }
      if (code < 0x20) fail('a control character in a string')
      if (code !== 0x5c) {
        at += 1
        continue
      }
      out += text.slice(start, at)
      const escape = text[at + 1]
      at += 2
      switch (escape) {
        case '"':
          out += '"'
          break
        case '\\':
          out += '\\'
          break
        case '/':
          out += '/'
          break
        case 'b':
          out += '\b'
          break
        case 'f':
          out += '\f'
          break
        case 'n':
          out += '\n'
          break
        case 'r':
          out += '\r'
          break
        case 't':
          out += '\t'
          break
        case 'u': {
          const hex = text.slice(at, at + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('a bad \\u escape')
          out += String.fromCharCode(parseInt(hex, 16))
          at += 4
          break
        }
        default:
          fail('a bad escape')
      }
      start = at
    }
  }
  const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y
  const number = (): number => {
    NUMBER.lastIndex = at
    const match = NUMBER.exec(text)
    if (!match) return fail('a bad number')
    at += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) fail(`the number ${match[0]} is beyond the double range`)
    if (match[1] === undefined && match[2] === undefined && Math.abs(value) >= SAFE && (BigInt(match[0]) > SAFE_BIG || BigInt(match[0]) < -SAFE_BIG)) fail(`the integer ${match[0]} is beyond ±2^53`)
    return value === 0 ? 0 : value
  }
  const literal = (word: string, value: JsonValue): JsonValue => {
    if (text.startsWith(word, at)) {
      at += word.length
      return value
    }
    return fail('an unexpected character')
  }
  // Iterative, so deep nesting cannot overflow the stack.
  type Frame = { array: JsonValue[] } | { object: Record<string, JsonValue>; keys: Set<string>; key: string }
  const stack: Frame[] = []
  let result: JsonValue = null
  let value: JsonValue
  for (;;) {
    space()
    const code = text.charCodeAt(at)
    let opened = false
    if ((code === 0x7b || code === 0x5b) && stack.length >= MAX_DEPTH) fail(`arrays and objects nested deeper than ${MAX_DEPTH} levels`)
    if (code === 0x7b) {
      at += 1
      space()
      const object: Record<string, JsonValue> = {}
      if (text.charCodeAt(at) === 0x7d) {
        at += 1
        value = object
      } else {
        if (text.charCodeAt(at) !== 0x22) fail('an object key that is not a string')
        const key = string()
        space()
        if (text.charCodeAt(at) !== 0x3a) fail('a missing `:`')
        at += 1
        stack.push({ object, keys: new Set([key]), key })
        opened = true
        value = null
      }
    } else if (code === 0x5b) {
      at += 1
      space()
      if (text.charCodeAt(at) === 0x5d) {
        at += 1
        value = []
      } else {
        stack.push({ array: [] })
        opened = true
        value = null
      }
    } else if (code === 0x22) value = string()
    else if (code === 0x2d || (code >= 0x30 && code <= 0x39)) value = number()
    else if (code === 0x74) value = literal('true', true)
    else if (code === 0x66) value = literal('false', false)
    else if (code === 0x6e) value = literal('null', null)
    else value = fail(at >= text.length ? 'an unexpected end' : 'an unexpected character')
    if (opened) continue
    // Put the value in its container; close containers that end here.
    for (;;) {
      const frame = stack[stack.length - 1]
      if (!frame) {
        result = value
        space()
        if (at !== text.length) fail('more after the value')
        return result
      }
      if ('array' in frame) frame.array.push(value)
      else setKey(frame.object, frame.key, value)
      space()
      const next = text.charCodeAt(at)
      if (next === 0x2c) {
        at += 1
        if ('object' in frame) {
          space()
          if (text.charCodeAt(at) !== 0x22) fail('an object key that is not a string')
          const key = string()
          if (frame.keys.has(key)) fail(`the key ${JSON.stringify(key)} twice in one object`)
          frame.keys.add(key)
          frame.key = key
          space()
          if (text.charCodeAt(at) !== 0x3a) fail('a missing `:`')
          at += 1
        }
        break
      }
      if ('array' in frame ? next === 0x5d : next === 0x7d) {
        at += 1
        stack.pop()
        value = 'array' in frame ? frame.array : frame.object
        continue
      }
      fail('a missing `,`')
    }
  }
}

/** UTF-8 bytes parsed as strict JSON. */
export const readJson = (bytes: Uint8Array, what: string): JsonValue => parseJson(utf8(bytes, what), what)
