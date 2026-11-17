# @kition/script

The Kition object model for scripts and extensions: read and edit a kit document as typed
objects, batched into one change per `sync()`, with commands and change events. The same script
runs in a page (an editor mounted with `@kition/embed`), in Node with the kit's WebAssembly
engine (`@kition/script/node`), against a kit's headless executable, or in a co-edited room.
Typings per kit are in `@kition/script/kits/<kit>`.

```sh
npm i @kition/script
```

```ts
import { openHeadless } from '@kition/script/node'
import '@kition/script/kits/note'

const file = await openHeadless(process.env.KITION_KIT_NOTE_BINARY!, 'Review.md')
const note = await file.model()
// ... edit through typed proxies, then:
await file.save()
await file.shutdown()
```

Documentation: https://developer.kition.ai/docs

License: Apache-2.0
