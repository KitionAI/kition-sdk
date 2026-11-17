# @kition/kdm

The Kit Data Model (KDM) for TypeScript kit engines and hosts: a replicated document of typed
objects, validated against the kit's schema, with transactions, origins and undo. It is the same
document model as the `kition-kdm` Rust crate, so both read and write the same bytes.
An ES module with type declarations, for Node and for bundlers.

```sh
npm i @kition/kdm
```

```ts
import { newDocId, parseSchema, person, Replica } from '@kition/kdm'

const schema = parseSchema({
  kdm: 1, kit: 'kit.example', schemaVersion: 1, root: 'Page',
  types: { Page: { fields: { title: { kind: 'string' } } } },
})
const doc = Replica.create(schema, newDocId(), 1n)
const page = doc.transact(person('user:ann'), (tx) => tx.create('Page', { title: 'One' }))
doc.get(page, 'title') // 'One'
const bytes = doc.snapshot() // load again with Replica.load(schema, bytes, actor)
```

Documentation: https://developer.kition.ai/docs

License: Apache-2.0
