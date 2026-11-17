# Script: the object model (`@kition/script`)

The full reference is [the object model reference](../platform/reference/object-model.md).

`@kition/script` reads and edits a document as typed objects, batched into one change per `sync()`.
The same script runs in three places:

| Where | How it opens a document |
| --- | --- |
| A page with an embedded editor | `editor.document()` on an editor mounted with `model: true` (`@kition/embed`; the editor's own engine and undo history) |
| Node, in process | `@kition/script/node`: the kit's WebAssembly engine loaded in Node |
| Node, headless executable | `openHeadless(binary, file)`: the kit's native engine, through `kition-kits serve` ([headless.md](headless.md), [hosts.md](hosts.md)) |
| A co-edited room | `openRoom(...)`: a replica on a `kition-sync/1` server |

```ts
import { openHeadless } from '@kition/script/node'
import '@kition/script/kits/note'

const file = await openHeadless(process.env.KITION_KIT_NOTE_BINARY!, 'Review.md')
const note = await file.model()
// ... edit through typed proxies, then:
await file.save()
await file.shutdown()
```

Typings per published kit: `@kition/script/kits/<kit>` (generated from each kit's schema).

Objects are named as the kit's own tools name them where its schema declares tool ids
([`KitObjectModel 1.0`](../platform/sets/object-model.md) OM9): a proxy's `id`, a ref field's
value, and a batch's `refs` read `item:10` rather than a KDM object id, so a script, an agent's
inspect, and the kit's diagnostics share one id space. Other objects keep their KDM object ids.
Examples: [examples/sdk-scripts](../../examples/sdk-scripts).

Kition kit platform: [`KitObjectModel 1.0`](../platform/sets/object-model.md); exchange and transactions (origins,
undo) in [`KitModel 1.1`](../platform/sets/model.md).
