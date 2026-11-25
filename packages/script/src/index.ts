/**
 * `@kition/script`: the Kition object model (`KitObjectModel 1.0`). Open a document from an
 * `@kition/embed` editor, a `KitConnection`, or a kit engine; queue reads and writes on typed
 * proxies; `sync()` sends them as one batch, which the kit runs as one undo step.
 */
export { advertiseCapabilitySets, CAPABILITY_SETS, capabilitySets, supports } from './capabilities'
export { BatchError, OBJECT_MODEL_CAPABILITY, type BatchOp, type BatchRequest, type BatchResult, type LoadedObject, type Origin } from '@kition/kdm'
export { ModelDocument, openDocument, type ChangedEvent, type ModelBackend, type ModelDescription, type OpenOptions } from './document'
export { kitDescriptor, registerKit, type KitDescriptor } from './kits'
export type { ConflictEvent, DocumentEventName, DocumentEvents, DocumentEventSource, KitCommandInfo, KitModel, ModelPort, SavedEvent, SelectionEvent } from './port'
export { NotSyncedError, PropertyNotLoadedError, RequestContext, type CommandMap, type CommandResult, type ModelList, type ModelMap, type ModelObject, type ModelText, type ModelTree, type ModelTreeNode } from './proxy'
export { isModelPort, portFromConnection, portFromEngine, type ConnectionLike, type EngineLike } from './sources'
