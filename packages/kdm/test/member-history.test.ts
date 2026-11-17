import { expect, it } from 'vitest'
import { diffStates, diffWithToolIds, newDocId, parseSchema, Replica, system, ToolIds } from '../src/index'

type State = { objects: Record<string, Record<string, unknown>> }

const schema = parseSchema({ kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Item', types: {
  Item: { toolId: { field: 'key' }, fields: { key: { kind: 'string', readOnly: true }, members: { kind: 'list', of: 'Member' } } },
  Member: { fields: { key: { kind: 'string', readOnly: true }, name: { kind: 'string' }, value: { kind: 'number' }, children: { kind: 'list', of: 'Member' } } },
} })

function fixture() {
  const replica = Replica.create(schema, newDocId(), 1n)
  replica.transact(system('setup'), tx => {
    tx.create('Item', { key: 'A' }, { id: 'item' })
    for (const [index, key] of ['a', 'b', 'c'].entries()) {
      tx.create('Member', { key, name: key, value: index }, { id: key })
      tx.create('Member', { key: `${key}-child`, name: 'child', value: 10 }, { id: `${key}-child` })
      tx.listInsert(key, 'children', 0, `${key}-child`)
      tx.listInsert('item', 'members', index, key)
    }
  })
  return replica
}

it('retains a raw member id and its content when an earlier sibling is deleted', () => {
  for (const changed of ['a', 'b', 'c']) {
    const replica = fixture(), before = replica.stateJson() as State
    replica.transact(system('outside'), tx => {
      if (changed === 'a') { tx.delete('a-child'); tx.delete('a') }
      else tx.set(changed, 'value', 20)
    })
    const after = replica.stateJson() as State
    const raw = diffStates(before, after)
    expect(raw.changed.some(item => item.id === 'b')).toBe(changed === 'b')
    expect(after.objects.b.value).toBe(changed === 'b' ? 20 : before.objects.b.value)
    expect(replica.list('item', 'members')).toContain('b')
  }
})

it('attributes deleted sibling subtrees at their old paths without changing the named member', () => {
  for (const key of ['a', 'c']) {
    const replica = fixture(), before = replica.stateJson() as State
    replica.transact(system('outside'), tx => { tx.delete(`${key}-child`); tx.delete(key) })
    const after = replica.stateJson() as State
    const told = diffWithToolIds(diffStates(before, after), schema, ToolIds.ofState(schema, before), ToolIds.ofState(schema, after))
    const index = key === 'a' ? 0 : 2
    expect(told.changed.find(item => item.id === 'A')?.edits).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: `members.${index}`, before: { key, name: key, value: index }, after: null }),
      expect.objectContaining({ field: `members.${index}.children.0`, before: { key: `${key}-child`, name: 'child', value: 10 }, after: null }),
    ]))
    expect(after.objects.b).toEqual(before.objects.b)
    expect(after.objects['b-child']).toEqual(before.objects['b-child'])
  }
})

it('keeps survivor edits at their new paths beside a deleted sibling subtree', () => {
  for (const child of [false, true]) {
    const replica = fixture(), before = replica.stateJson() as State
    replica.transact(system('outside'), tx => {
      tx.delete('a-child'); tx.delete('a')
      tx.set(child ? 'b-child' : 'b', 'value', 21)
    })
    const after = replica.stateJson() as State
    const told = diffWithToolIds(diffStates(before, after), schema, ToolIds.ofState(schema, before), ToolIds.ofState(schema, after))
    expect(told.changed.find(item => item.id === 'A')?.edits).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'members.0', after: null }),
      expect.objectContaining({ field: child ? 'members.0.children.0.value' : 'members.0.value', before: child ? 10 : 1, after: 21 }),
    ]))
  }
})
