import { expect, it } from 'vitest'
import { describeModel, parseSchema, person, Replica, replicaTarget, runBatch } from '../src/index'

it('enforces typed owning map values through transactions and tools', async () => {
  const schema = parseSchema({kdm:1,kit:'kit.test',schemaVersion:1,root:'Root',types:{
    Root:{fields:{cells:{kind:'map',owns:true,of:'Cell'},loose:{kind:'map',owns:true}}},
    Cell:{fields:{text:{kind:'string'}}},Other:{fields:{}},
  }})
  const replica = Replica.create(schema, '01920000-0000-7000-8000-0000000000bc', 1n)
  await runBatch(replicaTarget(replica), {ops:[
    {op:'create',type:'Root',id:'r'}, {op:'create',type:'Cell',id:'c',fields:{text:'value'}}, {op:'create',type:'Other',id:'o'},
    {op:'map.set',target:'root',field:'cells',key:'A1',value:'c'}, {op:'map.set',target:'root',field:'loose',key:'anything',value:{literal:42}},
  ]})
  expect(describeModel(replica).types.Root.fields.cells.of).toBe('Cell')
  for (const value of ['o',42,{body:'c'}]) {
    const before = replica.stateText()
    await expect(runBatch(replicaTarget(replica), {ops:[{op:'map.set',target:'root',field:'cells',key:'B1',value}]})).rejects.toMatchObject({code:'invalid-value'})
    expect(replica.stateText()).toBe(before)
  }
  const loaded = await runBatch(replicaTarget(replica), {load:[{target:'root',fields:['cells']}]})
  expect(loaded.loaded[0].fields.cells).toEqual({A1:'c'})
  expect(() => replica.transact(person('map-test'), tx => tx.mapSet('r', 'cells', 'B1', 'o'))).toThrow()
})

it('requires numbers at bounded members, while permitting containers and declared nulls', async () => {
  const replica = Replica.create(parseSchema({ kdm: 1, kit: 'kit.test', schemaVersion: 1, root: 'Root', types: { Root: { fields: {
    data: { kind: 'json', members: { roughness: { minimum: 0 }, resolution: { minimum: 1 }, 'resolution[]': { minimum: 1 }, count: { minimum: 0, multipleOf: 1, nullable: true } } },
  } } } }), '01920000-0000-7000-8000-0000000000bb', 1n)
  await runBatch(replicaTarget(replica), { ops: [{ op: 'create', type: 'Root', id: 'r', fields: { data: {} } }] })
  expect(describeModel(replica).types.Root.fields.data.members).toMatchObject({ count: { nullable: true } })
  for (const value of [{ roughness: 'bad' }, { roughness: false }, { roughness: null }, { resolution: [2, 'bad', 2] }, { count: 1.5 }, { count: false }]) {
    const before = replica.stateText()
    await expect(runBatch(replicaTarget(replica), { ops: [{ op: 'set', target: 'root', field: 'data', value }] })).rejects.toMatchObject({ code: 'invalid-value' })
    expect(replica.stateText()).toBe(before)
  }
  for (const value of [{}, { resolution: 2 }, { resolution: [2, 2, 2] }, { roughness: {} }, { count: null }]) {
    await runBatch(replicaTarget(replica), { ops: [{ op: 'set', target: 'root', field: 'data', value }] })
  }
})
