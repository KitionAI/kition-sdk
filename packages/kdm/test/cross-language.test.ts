/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Replica } from '../src/index'
import { crateFixture, me, testSchema, tsPage } from './helpers'

/** Written by `cargo run -p kition-kdm --example write-fixture -- packages/kdm/test/fixtures`; never regenerated to make a test pass. */
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

describe('documents made by the Rust KDM', () => {
  it('open to the identical canonical state', () => {
    const replica = Replica.load(testSchema(), fixture('rust-page.bin'), 9n)
    expect(replica.docId).toBe('01920000-0000-7000-8000-000000000001')
    expect(replica.stateText()).toBe(fixture('rust-page.json').toString('utf8'))
  })

  it('read the same through every accessor', () => {
    const replica = Replica.load(testSchema(), fixture('rust-page.bin'), 9n)
    const [page] = replica.objectsOfType('Page')
    const [a, b] = replica.list(page, 'shapes')
    expect(replica.get(page, 'title')).toBe('Fixture 页面')
    expect(replica.text(a, 'label')).toBe('季度😀回顾')
    expect(replica.textLength(a, 'label')).toBe(6)
    expect(replica.get(a, 'x')).toBe(12.5)
    expect(replica.get(b, 'transform')).toEqual({ rotate: 90, scale: [1, 2] })
    const tree = replica.tree(page, 'outline')
    expect(tree.map((entry) => entry.object)).toEqual([a, b])
    expect(tree[1].parent?.equals(tree[0].node)).toBe(true)
  })

  it('keep converging when edited from TypeScript', () => {
    const a = Replica.load(testSchema(), fixture('rust-page.bin'), 10n)
    const b = Replica.load(testSchema(), fixture('rust-page.bin'), 11n)
    const shape = a.objectsOfType('Shape')[0]
    a.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'TS:'))
    b.transact(me, (tx) => tx.set(shape, 'x', 1.25))
    a.importChanges(b.exportChanges(a.version()))
    b.importChanges(a.exportChanges(b.version()))
    expect(a.stateText()).toBe(b.stateText())
    expect(a.text(shape, 'label')).toMatch(/^TS:/)
    expect(a.get(shape, 'x')).toBe(1.25)
  })
})

describe('documents made by the TypeScript KDM for the Rust crate', () => {
  /** `crates/kition-kdm/tests/cross_language.rs` checks the same pair from Rust. */
  it('reload to the canonical state written next to them', () => {
    const bytes = readFileSync(fileURLToPath(new URL('../../../crates/kition-kdm/tests/fixtures/ts-page.bin', import.meta.url)))
    expect(Replica.load(testSchema(), bytes, 9n).stateText()).toBe(crateFixture('ts-page.json'))
  })

  it('are built with the awkward values the fixture is meant to hold', () => {
    const text = tsPage().stateText()
    for (const part of ['"x":1e+16', '"y":9100000000000000.0', '"x":0', '"z":1e-6', '"￿":2', '"😀":1', '"label":"😀b季"', 'a\ufffd"']) expect(text).toContain(part)
  })
})

describe('shallow snapshots across the two implementations', () => {
  /** Written by `cargo run -p kition-kdm --example write-fixture -- packages/kdm/test/fixtures shallow`. */
  it('open a Rust-made shallow snapshot to the identical canonical state', () => {
    const replica = Replica.load(testSchema(), fixture('rust-shallow.bin'), 9n)
    expect(replica.isShallow()).toBe(true)
    expect(replica.docId).toBe('01920000-0000-7000-8000-000000000001')
    expect(replica.stateText()).toBe(fixture('rust-shallow.json').toString('utf8'))
  })

  it('keep a Rust-made shallow replica converging when edited from TypeScript', () => {
    const a = Replica.load(testSchema(), fixture('rust-shallow.bin'), 10n)
    const b = Replica.load(testSchema(), fixture('rust-shallow.bin'), 11n)
    const shape = a.objectsOfType('Shape')[0]
    a.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'TS:'))
    b.transact(me, (tx) => tx.set(shape, 'x', 1.25))
    a.importChanges(b.exportChanges(a.version()))
    b.importChanges(a.exportChanges(b.version()))
    expect(a.stateText()).toBe(b.stateText())
    expect(a.text(shape, 'label')).toMatch(/^TS:after root/)
  })

  /** `crates/kition-kdm/tests/cross_language.rs` checks the same pair from Rust. */
  it('write a TypeScript-made shallow snapshot that reloads to the canonical state next to it', () => {
    const bytes = readFileSync(fileURLToPath(new URL('../../../crates/kition-kdm/tests/fixtures/ts-shallow.bin', import.meta.url)))
    const replica = Replica.load(testSchema(), bytes, 9n)
    expect(replica.isShallow()).toBe(true)
    expect(replica.stateText()).toBe(crateFixture('ts-shallow.json'))
  })
})
