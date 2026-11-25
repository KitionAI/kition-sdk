/**
 * The read-only replica: loading content and snapshots with the content encoding's rules, the
 * reads with the Rust `Replica`'s answers, and snapshot imports. Changes are in
 * `cross-language.test.ts`, on the fixture the Rust KDM writes.
 */
import { describe, expect, it } from 'vitest'
import { KdmError, parseSchema, Replica, Version } from '../src/index'
import { bytes, contentSchema, reasonOf } from './fixtures'

const DOC = '0193a5c4-0000-7000-8000-000000000001'
const LINE = '0193a5c4-0000-7000-8000-0000000000ff'
const A1 = '0193a5c4-0000-7000-8000-0000000000a1'
const B1 = '0193a5c4-0000-7000-8000-0000000000b1'
const B2 = '0193a5c4-0000-7000-8000-0000000000b2'
const B3 = '0193a5c4-0000-7000-8000-0000000000b3'

/** Content text with these object lines (`"<id>":{…}`), and a version for a snapshot. */
function content(objects: string[], options: { version?: string; header?: string; docId?: string; schemaVersion?: number } = {}): string {
  const version = options.version === undefined ? '' : `,"version":${options.version}`
  return `{"kdm":1,"kit":"kit.content","docId":"${options.docId ?? DOC}"${version}${options.header ?? ''},"schemaVersion":${options.schemaVersion ?? 2},"objects":{\n${objects.join(',\n')}${objects.length ? '\n' : ''}}}\n`
}

const load = (text: string) => Replica.load(contentSchema(), bytes(text))

const board = `"${A1}":{"$type":"Board","outline":[[0,"${B1}"],[1,"${B2}"],[0,"${B3}"]],"pages":["${B1}","${B2}","${B3}"],"title":"Q4","vars":{"gap":8,"zoom":1.5}}`
const pages = [
  `"${B1}":{"$type":"Page","body":[{"insert":"Ship "},{"attributes":{"bold":true},"insert":"it 😀"}],"count":3,"name":"Page 1","next":"${B2}"}`,
  `"${B2}":{"$type":"Page","name":""}`,
  `"${B3}":{"$type":"Page","body":"plain","box":{"b":[1,{"z":0,"a":-1.5}]},"name":"Page 3"}`,
]
const doc = () => load(content([board, ...pages]))

describe('a replica reads', () => {
  it('registers, with null for a field it does not hold', () => {
    const replica = doc()
    expect(replica.docId).toBe(DOC)
    expect(replica.kit).toBe('kit.content')
    expect(replica.minSchemaVersion()).toBe(2)
    expect(replica.objectType(B1)).toBe('Page')
    expect(replica.get(A1, 'title')).toBe('Q4')
    expect(replica.get(B1, 'count')).toBe(3)
    expect(replica.get(B1, 'next')).toBe(B2)
    expect(replica.get(B2, 'count')).toBeNull()
    expect(replica.get(B3, 'box')).toEqual({ b: [1, { a: -1.5, z: 0 }] })
    expect(Object.keys((replica.get(B3, 'box') as { b: [number, object] }).b[1])).toEqual(['a', 'z'])
  })

  it('texts as strings and runs, positions in UTF-16', () => {
    const replica = doc()
    expect(replica.text(B1, 'body')).toBe('Ship it 😀')
    expect(replica.textLength(B1, 'body')).toBe(10)
    expect(replica.textDelta(B1, 'body')).toEqual([{ insert: 'Ship ' }, { insert: 'it 😀', attributes: { bold: true } }])
    expect(replica.textDelta(B3, 'body')).toEqual([{ insert: 'plain' }])
    expect(replica.text(B2, 'body')).toBe('')
    expect(replica.textDelta(B2, 'body')).toEqual([])
    expect(replica.text(A1, 'notes')).toBe('')
  })

  it('lists, maps and trees, empty when not held', () => {
    const replica = doc()
    expect(replica.list(A1, 'pages')).toEqual([B1, B2, B3])
    expect(replica.mapGet(A1, 'vars', 'zoom')).toBe(1.5)
    expect(replica.mapGet(A1, 'vars', 'none')).toBeNull()
    expect(replica.mapEntries(A1, 'vars')).toEqual([['gap', 8], ['zoom', 1.5]])
    const tree = replica.tree(A1, 'outline')
    expect(tree.map((entry) => entry.object)).toEqual([B1, B2, B3])
    expect(tree[0].parent).toBeNull()
    expect(tree[1].parent?.equals(tree[0].node)).toBe(true)
    expect(tree[2].parent).toBeNull()
    const empty = load(content([`"${A1}":{"$type":"Board","title":"x"}`]))
    expect(empty.list(A1, 'pages')).toEqual([])
    expect(empty.mapEntries(A1, 'vars')).toEqual([])
    expect(empty.tree(A1, 'outline')).toEqual([])
  })

  it('objects of a type, sorted, and whether one exists', () => {
    const replica = doc()
    expect(replica.objectsOfType('Page')).toEqual([B1, B2, B3])
    expect(replica.objectsOfType('Nothing')).toEqual([])
    expect(replica.exists(B2)).toBe(true)
    expect(replica.exists('0193a5c4-0000-7000-8000-0000000000ee')).toBe(false)
  })

  it('the canonical state, every schema field written', () => {
    const state = doc().stateJson() as { meta: unknown; objects: Record<string, Record<string, unknown>> }
    expect(state.meta).toEqual({ docId: DOC, kdm: 1, kit: 'kit.content', schemaVersion: 2 })
    expect(state.objects[B2]).toEqual({ $type: 'Page', body: [], box: null, count: null, done: null, image: null, kind: null, name: '', next: null, scale: null })
    expect(state.objects[A1].outline).toEqual([
      { children: [{ children: [], object: B2 }], object: B1 },
      { children: [], object: B3 },
    ])
    expect(state.objects[A1].notes).toBe('')
    expect(doc().stateText()).toContain(`"${B3}":{"$type":"Page","body":[{"insert":"plain"}],"box":{"b":[1,{"a":-1.5,"z":0}]}`)
  })

  it('an object of a type the schema does not declare as its type only', () => {
    const replica = load(content([`"${A1}":{"$type":"Later","x":1}`]))
    expect((replica.stateJson() as { objects: Record<string, unknown> }).objects[A1]).toEqual({ $type: 'Later' })
    expect(reasonOf(() => replica.get(A1, 'x'))).toBe('unknown-type')
  })

  it('refuses what the schema does not declare, with the Rust reasons', () => {
    const replica = doc()
    expect(reasonOf(() => replica.get(B1, 'nothing'))).toBe('unknown-field')
    expect(reasonOf(() => replica.get(B1, 'body'))).toBe('invalid-value')
    expect(reasonOf(() => replica.text(B1, 'name'))).toBe('invalid-value')
    expect(reasonOf(() => replica.list(A1, 'vars'))).toBe('invalid-value')
    expect(reasonOf(() => replica.objectType('0193a5c4-0000-7000-8000-0000000000ee'))).toBe('not-found')
    expect(reasonOf(() => replica.get('0193a5c4-0000-7000-8000-0000000000ee', 'name'))).toBe('not-found')
  })
})

describe('loading', () => {
  it('refuses a document of another kit, of another KDM version, or of a newer schema', () => {
    expect(reasonOf(() => Replica.load(parseSchema({ kdm: 1, kit: 'kit.other', schemaVersion: 2, root: 'A', types: { A: { fields: {} } } }), bytes(content([]))))).toBe('schema')
    expect(reasonOf(() => load(content([]).replace('"kdm":1', '"kdm":2')))).toBe('schema')
    expect(reasonOf(() => load(content([], { schemaVersion: 3 })))).toBe('newer-schema')
  })

  it('refuses changes, a key named twice, a byte order mark and bytes that are not UTF-8', () => {
    expect(reasonOf(() => load(`{"kdm":1,"docId":"${DOC}","changes":[]}`))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","title":"a","title":"b"}`])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","title":"a","vars":{"k":1,"k":2}}`])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","title":"a","vars":{"k":{"x":1,"x":1}}}`])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","title":"a"}`, `"${A1}":{"$type":"Board","title":"b"}`])))).toBe('encoding')
    expect(reasonOf(() => load(`﻿${content([])}`))).toBe('encoding')
    expect(reasonOf(() => Replica.load(contentSchema(), new Uint8Array([0x7b, 0xff, 0x7d])))).toBe('encoding')
  })

  it('refuses unknown header keys, ids not in lowercase hyphenated UUID form, and fields holding null', () => {
    expect(reasonOf(() => load(content([], { header: ',"extra":1' })))).toBe('encoding')
    expect(reasonOf(() => load(content([], { docId: DOC.toUpperCase() })))).toBe('encoding')
    expect(reasonOf(() => load(content([], { version: `{"lineage":"${LINE.replaceAll('-', '')}","seq":1}` })))).toBe('encoding')
    expect(reasonOf(() => load(content([], { version: `{"lineage":"${LINE}","seq":1,"when":2}` })))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1.toUpperCase()}":{"$type":"Board","title":"a"}`])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","title":null}`])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","title":"a","vars":{"k":null}}`])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"title":"a"}`])))).toBe('encoding')
    // An id a host chose in another form is kept.
    expect(load(content([`"page:1":{"$type":"Page","name":"a"}`])).exists('page:1')).toBe(true)
  })

  it('refuses a list or tree naming no object of the document, a depth jump and a node named twice', () => {
    const ghost = '0193a5c4-0000-7000-8000-0000000000ee'
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","pages":["${ghost}"],"title":"a"}`])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","outline":[[0,"${ghost}"]],"title":"a"}`])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","outline":[[0,"${B1}"],[2,"${B2}"]],"title":"a"}`, ...pages])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","outline":[[0,"${B1}"],[1,"${B1}"]],"title":"a"}`, ...pages])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","outline":[{"children":[],"object":"${B1}"}],"title":"a"}`, ...pages])))).toBe('encoding')
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","outline":[[0,"${B1}",1]],"title":"a"}`, ...pages])))).toBe('encoding')
  })

  it('reads a snapshot whose lists and trees name objects it no longer holds, as Rust reads them (C13)', () => {
    const ghost = '0193a5c4-0000-7000-8000-0000000000ee'
    const board = `"${A1}":{"$type":"Board","outline":[[0,"${ghost}"],[1,"${B2}"],[0,"${B1}"]],"pages":["${ghost}","${B1}"],"title":"a"}`
    const snapshot = load(content([board, pages[0]], { version: `{"lineage":"${LINE}","seq":3}` }))
    expect(snapshot.list(A1, 'pages')).toEqual([ghost, B1])
    expect(snapshot.tree(A1, 'outline').map((entry) => entry.object)).toEqual([B1])
    expect((snapshot.stateJson() as { objects: Record<string, Record<string, unknown>> }).objects[A1].outline).toEqual([{ children: [], object: B1 }])
    // A file never names a missing object.
    expect(reasonOf(() => load(content([board, pages[0]])))).toBe('encoding')
  })

  it('tolerates number forms, key order, escaped keys and empty containers (C15), and refuses a key repeated through an escape', () => {
    const replica = load(content([`"${B1}":{"name":"a","$type":"Page","count":5.0,"scale":1E2,"box":[-0,1.50],"body":""}`, `"${A1}":{"$type":"Board","\u0074itle":"t","pages":[],"vars":{},"outline":[],"notes":""}`]))
    expect(replica.get(B1, 'count')).toBe(5)
    expect(replica.get(B1, 'scale')).toBe(100)
    expect(replica.get(B1, 'box')).toEqual([0, 1.5])
    expect(Object.is((replica.get(B1, 'box') as number[])[0], 0)).toBe(true)
    expect(replica.textDelta(B1, 'body')).toEqual([])
    expect(replica.get(A1, 'title')).toBe('t')
    expect(replica.stateText()).toContain(`"${A1}":{"$type":"Board","notes":"","outline":[],"pages":[],"title":"t","vars":{}}`)
    expect(reasonOf(() => load(content([`"${A1}":{"$type":"Board","title":"a","\u0074itle":"b"}`])))).toBe('encoding')
  })

  it('reads arrays and objects nested 127 deep, and refuses deeper (C14)', () => {
    // The outer object, `objects` and the object are 3 levels; a field's value nests at most 124.
    const nested = (levels: number) => '['.repeat(levels) + ']'.repeat(levels)
    expect(load(content([`"${B1}":{"$type":"Page","box":${nested(124)},"name":"a"}`])).get(B1, 'box')).toBeTruthy()
    expect(reasonOf(() => load(content([`"${B1}":{"$type":"Page","box":${nested(125)},"name":"a"}`])))).toBe('encoding')
  })

  it('refuses runs with other keys, and reads empty, null and adjacent equal runs as one text', () => {
    expect(reasonOf(() => load(content([`"${B1}":{"$type":"Page","body":[{"insert":"a","size":2}],"name":"a"}`])))).toBe('encoding')
    const replica = load(content([`"${B1}":{"$type":"Page","body":[{"insert":""},{"attributes":{},"insert":"a"},{"attributes":{"bold":null},"insert":"b"},{"attributes":{"bold":true},"insert":"c"},{"attributes":{"bold":true},"insert":"d"}],"name":"a"}`]))
    expect(replica.textDelta(B1, 'body')).toEqual([{ insert: 'ab' }, { insert: 'cd', attributes: { bold: true } }])
  })

  it('accepts whitespace, escapes and a missing final newline', () => {
    const text = `{ "kdm" : 1 , "kit":"kit.content", "docId":"${DOC}", "schemaVersion":2,\n "objects": { "${A1}": { "$type":"Board", "title":"\\u0051\\t4\\ud83d\\ude00" } } }`
    expect(load(text).get(A1, 'title')).toBe('Q\t4😀')
  })

  it('refuses an integer beyond ±2^53', () => {
    expect(reasonOf(() => load(content([`"${B1}":{"$type":"Page","count":9007199254740993,"name":"a"}`])))).toBe('encoding')
    expect(load(content([`"${B1}":{"$type":"Page","count":9007199254740992,"name":"a"}`])).get(B1, 'count')).toBe(2 ** 53)
  })
})

describe('snapshots', () => {
  const snapshot = (seq: number, title: string, line = LINE) => bytes(content([`"${A1}":{"$type":"Board","title":"${title}"}`], { version: `{"lineage":"${line}","seq":${seq}}` }))

  it('replace the state when they are ahead on the line, answering what changed', () => {
    const replica = Replica.load(contentSchema(), snapshot(3, 'a'))
    expect(replica.version().equals(Version.decode(replica.version().encode()))).toBe(true)
    expect(replica.importChanges(snapshot(3, 'a'))).toEqual([])
    expect(replica.importChanges(snapshot(5, 'b'))).toEqual([A1])
    expect(replica.get(A1, 'title')).toBe('b')
    expect(replica.version().seq).toBe(5)
  })

  it('are refused behind the replica, on another line, or of another document', () => {
    const replica = Replica.load(contentSchema(), snapshot(5, 'a'))
    expect(reasonOf(() => replica.importChanges(snapshot(4, 'b')))).toBe('stale')
    expect(reasonOf(() => replica.importChanges(snapshot(6, 'b', '0193a5c4-0000-7000-8000-0000000000aa')))).toBe('stale')
    expect(reasonOf(() => replica.importChanges(bytes(content([]))))).toBe('stale')
    expect(reasonOf(() => replica.importChanges(bytes(content([], { docId: '0193a5c4-0000-7000-8000-000000000009', version: `{"lineage":"${LINE}","seq":9}` }))))).toBe('wrong-document')
    expect(reasonOf(() => replica.importChanges(bytes(`{"docId":"${DOC}"}`)))).toBe('encoding')
    expect(replica.get(A1, 'title')).toBe('a')
  })
})

describe('versions', () => {
  it('are 0 or 24 bytes: the lineage, then seq big-endian', () => {
    expect(Version.empty().encode()).toEqual(new Uint8Array(0))
    const version = Replica.load(contentSchema(), bytes(content([], { version: `{"lineage":"${LINE}","seq":258}` }))).version()
    const encoded = version.encode()
    expect(encoded.length).toBe(24)
    expect([...encoded.subarray(16)]).toEqual([0, 0, 0, 0, 0, 0, 1, 2])
    expect(Version.decode(encoded).lineage).toBe(LINE)
    expect(Version.decode(encoded).seq).toBe(258)
    expect(reasonOf(() => Version.decode(new Uint8Array(5)))).toBe('encoding')
  })

  it('include the empty version and earlier ones of their line', () => {
    const at = (seq: number, line = LINE) => Replica.load(contentSchema(), bytes(content([], { version: `{"lineage":"${line}","seq":${seq}}` }))).version()
    expect(at(3).includes(Version.empty())).toBe(true)
    expect(at(3).includes(at(2))).toBe(true)
    expect(at(2).includes(at(3))).toBe(false)
    expect(at(3).includes(at(1, '0193a5c4-0000-7000-8000-0000000000aa'))).toBe(false)
    expect(Version.empty().includes(at(1))).toBe(false)
    expect(at(3).equals(at(3))).toBe(true)
  })
})

it('throws only KdmError for bad bytes', () => {
  for (const text of ['', '{', '[]', 'null', '{"kdm":1}', `{"kdm":1,"kit":"kit.content","docId":"${DOC}","schemaVersion":2,"objects":[]}`]) {
    expect(() => load(text)).toThrow(KdmError)
  }
})
