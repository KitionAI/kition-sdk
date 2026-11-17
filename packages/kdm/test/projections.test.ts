import { expect, it } from 'vitest'
import { describeModel, diffStates, parseSchema, ProjectionView, Replica, replicaTarget, runBatch, type BatchTarget, type ProjectedObject } from '../src/index'
import {routeProjection} from '../src/projection'

const schema = {
  kdm: 1, kit: 'kit.projected', schemaVersion: 1, root: 'Document', types: {
    Document: { fields: { text: { kind: 'string' }, lines: { kind: 'list', of: 'Line' } } },
    Line: { projected: true, fields: { text: { kind: 'string' } }, projectedOps: {
      'set.text': { command: 'line.set', params: { id: 'target', text: 'value' } },
      create: {command:'line.create',params:{id:'id',text:'fields.text',at:'at'}},
      delete: {command:'line.delete',params:{id:'target'}},
      'list.move': {command:'line.move',params:{id:'target',to:'to'}},
    } },
  },
}

it('declares projected types and never stores their objects', async () => {
  const parsed = parseSchema(schema)
  const replica = Replica.create(parsed, '01920000-0000-7000-8000-0000000000bb', 1n)
  const before = replica.stateText()
  expect(() => replica.transact({kind:'agent',principal:'test'}, tx => { tx.create('Line', { text: 'Never stored' }) })).toThrow('never stored')
  expect(replica.stateText()).toBe(before)
  expect(describeModel(replica).types.Line.projected).toBe(true)
  expect(describeModel(replica).types.Line.projectedOps).toEqual(schema.types.Line.projectedOps)
  const root = structuredClone(schema)
  root.root = 'Line'
  expect(() => parseSchema(root)).toThrow('root type cannot be projected')
})

function lines() {
  const replica=Replica.create(parseSchema(schema),'01920000-0000-7000-8000-0000000000bb',1n)
  replica.transact({kind:'agent',principal:'test'},tx=>{tx.create('Document',{text:'a=Alpha\nb=Beta'},{id:'doc'})})
  const projectedObjects=():ProjectedObject[]=>(replica.get('doc','text') as string).split('\n').map((line,index)=>{
    const at=line.indexOf('=')
    return {id:line.slice(0,at),type:'Line',fields:{text:line.slice(at+1)},at:{parent:'doc',field:'lines',index}}
  })
  const target:BatchTarget={...replicaTarget(replica),projectedObjects,command:(command,params,origin)=>{
    const values=params as Record<string,unknown>
    const objects=projectedObjects()
    const id=typeof values.id==='string'?values.id:'new'
    const at=objects.findIndex(object=>object.id===id)
    if(command==='line.set') {if(at<0)throw Error('no line');objects[at].fields.text=values.text}
    else if(command==='line.delete') {if(at<0)throw Error('no line');objects.splice(at,1)}
    else if(command==='line.create')objects.splice(typeof values.at==='number'?values.at:objects.length,0,{id,type:'Line',fields:{text:values.text}})
    else if(command==='line.move') {if(at<0)throw Error('no line');const [object]=objects.splice(at,1);objects.splice(values.to as number,0,object)}
    else throw Error('undeclared command')
    replica.transact(origin,tx=>tx.set('doc','text',objects.map(object=>`${object.id}=${object.fields.text}`).join('\n')))
    return {id}
  }}
  return {replica,target,projectedObjects}
}

it('accepts projected tree and owning-ref schemas',()=>{
  for(const field of [{kind:'tree',of:'Line'},{kind:'ref',of:'Line',owns:true}]){
    const invalid={...schema,types:{...schema.types,Document:{fields:{...schema.types.Document.fields,lines:field}}}}
    expect(()=>parseSchema(invalid)).not.toThrow()
  }
})

it('reads nested projected trees and owning refs and rejects invalid containment',()=>{
  const parsed=parseSchema({kdm:1,kit:'kit.nested',schemaVersion:1,root:'Document',types:{
    Document:{fields:{sections:{kind:'tree',of:'Section'}}},
    Section:{projected:true,fields:{name:{kind:'string'},body:{kind:'ref',of:'Body',owns:true}},projectedOps:{create:{command:'section.create'}}},
    Body:{projected:true,fields:{text:{kind:'string'}},projectedOps:{create:{command:'body.create'},'ref.set':{command:'body.attach',params:{id:'target',in:'in'}}}}
  }})
  const replica=Replica.create(parsed,'01920000-0000-7000-8000-0000000000bb',1n)
  replica.transact({kind:'agent',principal:'test'},tx=>tx.create('Document',{}, {id:'doc'}))
  const objects:ProjectedObject[]=[
    {id:'section',type:'Section',fields:{name:'Parent'},at:{parent:'doc',field:'sections',index:0}},
    {id:'nested',type:'Section',fields:{name:'Child'},at:{parent:'doc',field:'sections',node:'section',index:0}},
    {id:'body',type:'Body',fields:{text:'Contents'},at:{parent:'nested',field:'body'}}
  ]
  const view=new ProjectionView(replica,objects)
  expect(view.state.objects.doc.sections).toEqual([{object:'section',children:[{object:'nested',children:[]}]}])
  expect(view.state.objects.nested.body).toBe('body')
  expect(view.state.objects.section.body).toBeNull()
  expect(replica.objectsOfType('Section')).toEqual([])
  expect(routeProjection(parsed,view,'doc',{op:'create',type:'Body',in:'nested.body',fields:{text:'New'}})?.command).toBe('body.create')
  expect(routeProjection(parsed,view,'doc',{op:'set',target:'section',field:'body',value:'body'})).toEqual({command:'body.attach',params:{id:'body',in:'section.body'}})
  const cycle=structuredClone(objects);cycle[0].at!.node='nested'
  expect(()=>new ProjectionView(replica,cycle)).toThrow('cycle')
  const duplicate=structuredClone(objects);duplicate.push({...objects[2],id:'second'})
  expect(()=>new ProjectionView(replica,duplicate)).toThrow()
})

it('respects read-only projected create destinations',()=>{
  const {replica,projectedObjects}=lines()
  const parsed=parseSchema(schema)
  parsed.types.Document.fields.lines.readOnly=true
  const view=new ProjectionView(replica,projectedObjects())
  expect(()=>routeProjection(parsed,view,'doc',{op:'create',type:'Line',in:'root.lines',fields:{text:'New'}})).toThrow('read-only')
})

it('rejects stored projected objects in snapshots and imported changes',()=>{
  const {replica}=lines()
  const stored=parseSchema(structuredClone(schema))
  stored.types.Line.projected=false
  delete stored.types.Line.projectedOps
  const writer=Replica.load(stored,replica.snapshot(),2n)
  writer.transact({kind:'agent',principal:'writer'},tx=>tx.create('Line',{text:'stored'},{id:'forged'}))
  expect(()=>Replica.load(parseSchema(schema),writer.snapshot(),3n)).toThrow('never stored')
  const before=replica.stateText()
  expect(()=>replica.importChanges(writer.exportChanges(replica.version()))).toThrow('never stored')
  expect(replica.stateText()).toBe(before)
})

it('routes a projected parent virtual list through its child mapping',()=>{
  const parsed=parseSchema({kdm:1,kit:'kit.projected',schemaVersion:1,root:'Document',types:{
    Document:{fields:{groups:{kind:'list',of:'Group'}}},
    Group:{projected:true,fields:{lines:{kind:'list',of:'Line'}},projectedOps:{'list.move':{command:'group.move'}}},
    Line:{projected:true,fields:{text:{kind:'string'}},projectedOps:{'list.move':{command:'line.move',params:{id:'target',to:'to'}}}},
  }})
  const replica=Replica.create(parsed,'01920000-0000-7000-8000-0000000000bb',1n)
  replica.transact({kind:'agent',principal:'test'},tx=>tx.create('Document',{}, {id:'doc'}))
  const view=new ProjectionView(replica,[
    {id:'g',type:'Group',fields:{},at:{parent:'doc',field:'groups',index:0}},
    {id:'a',type:'Line',fields:{text:'Alpha'},at:{parent:'g',field:'lines',index:0}},
    {id:'b',type:'Line',fields:{text:'Beta'},at:{parent:'g',field:'lines',index:1}},
  ])
  const op={op:'list.move',target:'g',field:'lines',from:0,to:1}
  expect(routeProjection(parsed,view,'doc',op)).toEqual({command:'line.move',params:{id:'a',to:1}})
  parsed.types.Group.fields.lines.readOnly=true
  expect(()=>routeProjection(parsed,view,'doc',op)).toThrow('read-only')
})

it('reads computed fields and membership through loads and inventory',async()=>{
  const {replica,target}=lines()
  const read=await runBatch(target,{ops:[],objects:true,load:[{target:'root'},{target:'a'}]})
  expect(read.loaded[0].fields.lines).toEqual(['a','b'])
  expect(read.loaded[1]).toMatchObject({id:'a',type:'Line',projected:true,fields:{text:'Alpha'}})
  expect(read.objects?.map(object=>object.id)).toEqual(['a','b','doc'])
  expect(replica.objectsOfType('Line')).toEqual([])
})

it('routes projected edits through commands and binds created ids',async()=>{
  const moving=lines()
  await runBatch(moving.target,{ops:[{op:'create',type:'Line',id:'c',fields:{text:'Third'}}]})
  const beforeMove=new ProjectionView(moving.replica,moving.projectedObjects()).state
  await runBatch(moving.target,{ops:[{op:'list.move',target:'root',field:'lines',from:0,to:2}]})
  const moveDiff=diffStates(beforeMove,new ProjectionView(moving.replica,moving.projectedObjects()).state)
  const {replica,target,projectedObjects}=lines()
  const before=new ProjectionView(replica,projectedObjects()).state
  const answer=await runBatch(target,{ops:[
    {op:'set',target:'a',field:'text',value:'Edited'},
    {op:'create',type:'Line',id:'c',ref:'$line',in:'root.lines',fields:{text:'Created'}},
    {op:'set',target:'$line',field:'text',value:'Bound'},
    {op:'list.move',target:'root',field:'lines',from:2,to:0},
    {op:'delete',target:'b'},
  ],load:[{target:'$line'},{target:'root'}]})
  expect(answer.refs.$line).toBe('c')
  expect(answer.loaded[0].fields.text).toBe('Bound')
  expect(answer.loaded[1].fields.lines).toEqual(['c','a'])
  const diff=diffStates(before,new ProjectionView(replica,projectedObjects()).state)
  expect(diff.created.some(item=>item.id==='c')).toBe(true)
  expect(diff.deleted.some(item=>item.id==='b')).toBe(true)
  expect(diff.changed.some(item=>item.id==='a')).toBe(true)
  expect(moveDiff.moved.some(item=>item.id==='a')).toBe(true)
  expect(replica.objectsOfType('Line')).toEqual([])
  expect(replica.list('doc','lines')).toEqual([])
})

it('refuses unmapped writes and invalid or ambiguous projections',async()=>{
  const {replica,target,projectedObjects}=lines()
  const before=replica.stateText()
  await expect(runBatch(target,{ops:[{op:'text.mark',target:'a',field:'text',start:0,end:1,key:'bold',value:true}]})).rejects.toMatchObject({code:'read-only'})
  expect(replica.stateText()).toBe(before)
  for(const change of ['duplicate','missing-field','gap','shadow','wrong-type','wrong-container']){
    const objects=projectedObjects()
    if(change==='duplicate')objects.push(structuredClone(objects[0]))
    else if(change==='missing-field')objects[0].fields={}
    else if(change==='gap')objects[0].at!.index=9
    else if(change==='shadow')objects[0].id='doc'
    else if(change==='wrong-type')objects[0].type='Document'
    else objects[0].at!.field='text'
    expect(()=>new ProjectionView(replica,objects),change).toThrow()
  }
})
