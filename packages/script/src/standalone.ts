/**
 * `@kition/sdk/script/standalone`: the object model in one self-contained module, for a page
 * without a bundler (a `<script type="module">` that imports it by URL). Loro's WebAssembly is
 * inlined and every generated kit is registered, so `openDocument` works on a document of any kit.
 * It holds a Loro and a KDM of its own: an app with a bundler imports `@kition/sdk/script` (and
 * `/script/kits/<kit>`) instead, which share them with `@kition/sdk/kdm` and `/sync`.
 */
import { KITS } from '../kits/index'
import { registerKit } from './kits'

export * from './index'
export * from '../kits/index'

// Registered here as well as in each kit's module, so a bundler that drops a kit module whose
// exports a page does not use still leaves every kit registered.
for (const kit of Object.values(KITS)) registerKit(kit)
