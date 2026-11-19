// Every generated kit (`@kition/script/kits`): importing this module registers each kit's schema with
// @kition/script, so `openDocument` (and an extension host) works on documents of any of them. The
// typings stay per kit (`@kition/script/kits/<kit>`): their type names overlap.
import type { KitDescriptor } from '../src/kits'
import { boardKit } from './board'
import { cadKit } from './cad'
import { designKit } from './design'
import { docKit } from './doc'
import { filmKit } from './film'
import { htmlKit } from './html'
import { layoutKit } from './layout'
import { motionKit } from './motion'
import { noteKit } from './note'
import { pdfKit } from './pdf'
import { photoKit } from './photo'
import { sceneKit } from './scene'
import { sheetKit } from './sheet'
import { slideKit } from './slide'
import { tableKit } from './table'
import { vectorKit } from './vector'

export { boardKit, cadKit, designKit, docKit, filmKit, htmlKit, layoutKit, motionKit, noteKit, pdfKit, photoKit, sceneKit, sheetKit, slideKit, tableKit, vectorKit }

/** Every generated kit's descriptor, by kit id. */
export const KITS: Readonly<Record<string, KitDescriptor>> = Object.fromEntries(
  [boardKit, cadKit, designKit, docKit, filmKit, htmlKit, layoutKit, motionKit, noteKit, pdfKit, photoKit, sceneKit, sheetKit, slideKit, tableKit, vectorKit].map((kit) => [kit.id, kit]),
)
