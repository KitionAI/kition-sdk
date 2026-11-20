/**
 * The public shapes of `@kition/embed` (`KitEmbed 1.3`, with EM25's opening and EM28): what an
 * integrator passes to `KitionEmbed.mount`, the providers it implements, and the editor it gets
 * back. Every member a later version added is optional, so a `KitEmbed 1.0` page works unchanged.
 */
import type { CommentAnchor, Origin } from '@kition/kdm'
import type { AgentPort, AgentPortOptions } from './agent'
import type { AiRunResult, DraftComparison, DraftInfo, DraftSummary, KitCommentAnchor, KitConflict, KitDiagnostic, KitHostService, KitHostServices, KitLease, KitLinkRef, KitNotifications, KitSchemaReport, KitShownThread, KitTheme, KitUiConfig, KitUiHostButton, KitView, StoredReplica } from '@kition/kit-ui-protocol'
import type { ConnectionState, Presence, Role, SaveAuthor, SaveState, SaveTrigger } from '@kition/sync'
import type { OpenTokenKey } from '@kition/sync/openToken'
// The object model, bundled with the editor and loaded only by `editor.document()`.
import type { ModelDocument } from '../../script/src/document'
import type { CommandMap, ModelObject } from '../../script/src/proxy'
import type { EmbedConflictError } from './errors'

export type { AgentPort, AgentPortOptions, AgentRelayTransport, AgentTool, AgentErrorCode, JsonRpcMessage } from './agent'
export type { CommandMap, CommentAnchor, DraftComparison, DraftInfo, DraftSummary, KitLease, KitLinkRef, KitUiHostButton, KitView, ModelDocument, ModelObject, Origin, Presence, Role, StoredReplica }

/** The kit package to show: its id (`kit.json` `id`) and the base URL it is served from. */
export type EmbedKit = {
  id: string
  /** The kit package's base URL (`https://kits.example.com/slide-ui/`); its origin is the editor's. */
  url: string
  /** The UI entry inside the package; `index.html` by default. */
  entry?: string
  /**
   * The kit's KDM schema (`@kition/script/kits/<kit>`'s descriptor `schema`), for reviewing drafts
   * and the agent's object-model calls when the kit's engine does not describe its own. When not
   * given, the package's own `model/schema.json` is read, else `@kition/script`'s generated kit's
   * (`KitEmbed 1.3`).
   */
  schema?: object
}

/**
 * The document: the integrator's id for it, and the file name the kit sees (its format comes from
 * it). `name` may be left out when the storage answers `info`, which then names the file.
 */
export type EmbedFile = { id: string; name?: string }

/** A file as the storage reads it: its bytes and a version that changes with every write. */
export type StoredFile = { bytes: ArrayBuffer | Uint8Array; version: string }

/** What `StorageProvider.info` tells of a file without reading it (`KitEmbed 1.1`). */
export type FileInfo = { name: string; version: string; size?: number; mime?: string }

/**
 * Blobs by their content hash (lowercase hex SHA-256), as a kit's replica references them
 * (`KitEmbed 1.1`). With one, the replica's blobs (pictures, media) are kept here instead of
 * inside the stored replica (`storage.replica`, or this browser's IndexedDB).
 */
export type BlobStore = {
  /** The blob's bytes, or `null` when the store does not hold it. */
  read: (hash: string) => Promise<ArrayBuffer | Uint8Array | null>
  /** Keeps the blob; a store that already holds the hash may skip it. */
  write: (hash: string, bytes: Uint8Array) => Promise<void>
}

/**
 * Where the integrator keeps documents. Versions are opaque, non-empty strings that change on
 * every write; the editor passes back the one it last saw, so a write over someone else's is
 * refused (`EmbedConflictError`) rather than lost.
 */
export type StorageProvider = {
  read: (fileId: string) => Promise<StoredFile>
  /**
   * The file's current version without its bytes (a cheap change check); `null` if it is gone.
   * Optional when `info` is given, whose `version` then answers it.
   */
  stamp?: (fileId: string) => Promise<string | null>
  /** The file's name, version, and optionally size and type, without its bytes; `null` if it is gone (`KitEmbed 1.1`). */
  info?: (fileId: string) => Promise<FileInfo | null>
  /**
   * Replaces the file; throws `EmbedConflictError` when its version is no longer `expectedVersion`.
   * In a managed room (KitCollab 1.4) `save` says what the version holds: store one version with
   * these authors (managed-collab.md SV1), and refuse it as a conflict when `docKey` is not the
   * file's current generation (SV3).
   */
  write: (fileId: string, bytes: Uint8Array, options: { expectedVersion: string | null; save?: EmbedSaveInfo }) => Promise<{ version: string }>
  /** Makes a new file (an export, a saved copy); without it, the kit's exports are refused. */
  create?: (name: string, bytes: Uint8Array) => Promise<{ fileId: string; name?: string; version?: string }>
  /**
   * Keeps the document's replica next to its file (Kit UI protocol capability `replica`). Without
   * it, a collaboration session keeps it in this browser's IndexedDB, keyed by the file id; a
   * single-user editor needs none.
   */
  replica?: ReplicaStore
  /** Keeps the editor's collaboration records; `localStorage` (`kition.embed.rooms.v1`) by default. */
  state?: EmbedState
  /** Keeps the replica's blobs by hash (`KitEmbed 1.1`); without it they stay inside the stored replica. */
  blob?: BlobStore
  /**
   * The URL the files the document links (media, linked pictures, fonts) are read from in ranges
   * (`KitEmbed 1.1`, Kit UI protocol `document.lend`): the kit reads `<url>/<path>` with `Range`
   * requests from its own origin, so the server answers CORS for it and the kit origin's
   * `connect-src` lists it. `null` or absent: the kit is lent no files.
   */
  lend?: (fileId: string) => string | URL | null | Promise<string | URL | null>
  /**
   * The file a link in `fromFileId`'s document names, as the page resolves it (`KitEmbed 1.5`,
   * EM25), or `null` when it names none. With `open`, the kit offers opening linked files
   * (capability `open-file`); the embed asks only from a person's gesture in the kit (OP1).
   */
  resolveLink?: (fromFileId: string, link: KitLinkRef) => Promise<ResolvedLink | null>
  /** Opens the file in the page's own UI, at `view` when given (EM25, OP2, OP3); `opened: false` when the person cancelled. */
  open?: (fileId: string, view?: KitView) => Promise<{ opened: boolean }>
  /**
   * Opens a web address in the system's browser or mail client once the person confirmed it with
   * the full address shown (EM25, OP8); `opened: false` when they declined. The kit offers it
   * (capability `open-url`); the embed passes only `https:`, `http:`, and `mailto:` addresses from
   * a person's gesture (OP6, OP7).
   */
  openUrl?: (url: string) => Promise<{ opened: boolean }>
}

/** `StorageProvider.resolveLink`: the linked file; `path` is relative to the linking file, as the page names it. */
export type ResolvedLink = { fileId: string; name: string; kitId: string | null; version: string | null; path: string }

export type ReplicaStore = {
  read: (fileId: string) => Promise<StoredReplica | null>
  write: (fileId: string, replica: StoredReplica) => Promise<void>
}

/**
 * What one save of a managed room writes (KitCollab 1.4, managed-collab.md section 3): what started
 * it, the room's change it holds, everyone whose changes are in it since the last version (from
 * the sync server's log), the room's file generation, and the sync server's signed `receipt` of
 * all that (`ksr1.`, I6). The host MUST verify the receipt and take the authors, `seq` and
 * generation from it; `authors` here are for showing only, since a page could change them.
 */
export type EmbedSaveInfo = { trigger: SaveTrigger; seq: number; authors: SaveAuthor[]; docKey: string; docId: string; receipt: string }

/** A small key-value store for JSON values. */
export type EmbedState = {
  get: (key: string) => unknown | Promise<unknown>
  set: (key: string, value: unknown) => void | Promise<void>
}

export type EmbedUser = { id: string; name: string; avatar?: string }

/** What a person may do with a document: edit it, only comment on it, or only view it. */
export type PermissionMode = 'edit' | 'comment' | 'view'

/** Who the person is, and (`KitEmbed 1.1`) who others are and what the person may do. */
export type IdentityProvider = {
  /**
   * A token for the sync server, asked for on every connection, so it can be refreshed. Needed
   * with `collaboration`.
   */
  token?: () => string | Promise<string>
  /** The person, for the presence others see and as the author of their comments. Needed with `collaboration`. */
  user?: () => EmbedUser | Promise<EmbedUser>
  /**
   * Other people by id, for their names and avatars in `presence` and `comments` (`KitEmbed
   * 1.1`). Answers the ones it knows; each id is asked for once per editor.
   */
  users?: (ids: string[]) => EmbedUser[] | Promise<EmbedUser[]>
  /**
   * What the person may do with the file, asked for each time the editor opens it (`KitEmbed
   * 1.1`). The stricter of it and the `permissions` option applies.
   */
  permissions?: (fileId: string) => { mode: PermissionMode } | Promise<{ mode: PermissionMode }>
}

export type EmbedCollaboration = {
  /** The sync server's WebSocket URL (`wss://…/v1/sync`). */
  server: string
  /**
   * The room to join: a document id or a share link. One editor per page co-edits a document; a
   * second one fails `ready()` with `EmbedError` `document-open`. Omitted: the document's own room, made
   * the first time (`editor.collab.shareLink` then answers links to it).
   */
  room?: string
  /**
   * The editor co-edits through an open token only (KitCollab 1.4): `ready()` fails when the
   * identity provider answers any other token. Every editor asks for its token before it
   * connects either way, and an open-token editor never shares another editor's connection.
   */
  open?: boolean
  /**
   * Hosts' public keys to verify open tokens with in the page too (KitCollab 1.4, OT2): an editor
   * whose token does not verify does not open. Without them the sync server alone verifies it.
   */
  openKeys?: OpenTokenKey[]
  /** The Kition Server id open tokens must name (`aud`, I2); needed with `openKeys`. */
  openAudience?: string
  /** How often a managed room autosaves while it has unsaved changes, in milliseconds (default 30 000; SV2). */
  autosaveMs?: number
}

/** `colorScheme` and the `--kit-*` tokens to change; the rest keep their defaults for the scheme. */
export type EmbedTheme = { colorScheme: 'light' | 'dark'; tokens?: Record<string, string>; brand?: KitTheme['brand'] }

/**
 * `view` opens the document read-only; `comment` (`KitEmbed 1.1`) also read-only for its content,
 * while the person still writes comment threads (Kit UI protocol `document.comments`).
 */
export type EmbedPermissions = { mode: PermissionMode }

/**
 * The editor's interface as the page wants it (`KitEmbed 1.1`): the Kit UI protocol's UI
 * configuration (`hide`, `disable`, `add`, `personal`, section 9), and two shorthands over it.
 */
export type EmbedUi = KitUiConfig & {
  /** `none` hides the kit's ribbon tabs (`tab:*`); `full`, the default, hides nothing. */
  toolbar?: 'full' | 'none'
  /**
   * The only panels to show, by `panel:` id or by name (`comments` is `panel:comments`); the kit's
   * other panels are hidden once it has opened. Absent: every panel.
   */
  panels?: string[]
  /**
   * Keeps what the person hid themselves (Kit UI protocol `host/customize`): with it, the kit offers
   * "Customize interface…", and the page passes the hides back as `personal` on later mounts.
   */
  customize?: (personal: { hide: string[] }) => void | Promise<void>
}

export type EmbedOptions = {
  kit: EmbedKit
  file: EmbedFile
  storage: StorageProvider
  /**
   * Needed only with `collaboration`. Editors co-editing through the same server share the page's
   * one connection to it, opened with the first editor's identity: the first identity wins.
   */
  identity?: IdentityProvider
  /** Omitted: single-user. */
  collaboration?: EmbedCollaboration
  /** A BCP 47 tag; the browser's language by default. */
  locale?: string
  theme?: EmbedTheme
  permissions?: EmbedPermissions
  /** What the kit's editor shows and allows (`KitEmbed 1.1`); everything by default. */
  ui?: EmbedUi
  /** How long the kit may take to open the document; two minutes by default. */
  timeoutMs?: number
  /**
   * Lets the page edit the document through the object model (`@kition/script`'s
   * `openDocument(editor)`): the kit keeps a replica, in memory when `storage` has no `replica`
   * store and the editor does not co-edit.
   */
  model?: boolean
  /**
   * What the kit lets the person take out of the document and the watermark it draws (Kit UI
   * `document.permissions`, `document.watermark`), for a page that decided them
   * itself (the embed server, from its open token). A managed room's open token decides
   * them instead.
   */
  display?: EmbedDisplay
  /**
   * The page's own shortcuts (`KitEmbed 1.6`, EM28), as `Cmd+S`: the kit forwards them instead of
   * handling them, heard as the `shortcut` event. Listing `Cmd+S` leaves saving to the page
   * (`editor.save()`). None by default.
   */
  shortcuts?: string[]
  /**
   * The page's host services by id (`KitEmbed 1.7`, EM29; Kit UI protocol section 7k), offered to
   * the kit when the document's permissions allow each (UI-V4). Params arrive checked. A handler
   * refuses by throwing an error whose `reason` is one of `SERVICE_ERROR_REASONS`; any other error
   * answers `failed`.
   */
  services?: EmbedServices
  /**
   * The page keeps the document's comment threads itself and the kit anchors them (`KitEmbed 1.7`,
   * EM30, capability `comment-anchors`): new threads arrive as the `comment.create` service,
   * `editor.comments.show` marks them, and `activated` hears the person click a marker.
   */
  comments?: { activated: (threadId: string) => void }
}

/** `EmbedOptions.services`: one handler per host service the page serves. */
export type EmbedServices = { [S in KitHostService]?: (params: KitHostServices[S][0]) => KitHostServices[S][1] | Promise<KitHostServices[S][1]> }

/** A thread the page keeps, as the kit marks it (`editor.comments.show`). */
export type EmbedShownThread = KitShownThread

/** Where a comment thread is in the document, as the kit reports it (Kit UI protocol section 7k). */
export type EmbedCommentAnchor = KitCommentAnchor

/** The `shortcut` event: a key of `EmbedOptions.shortcuts` pressed in the kit (Kit UI protocol `host/shortcut`). */
export type EmbedShortcut = KitNotifications['host/shortcut']

/** `EmbedOptions.display`: absent members leave the kit's defaults (everything allowed, no watermark). */
export type EmbedDisplay = { permissions?: { download: boolean; export: boolean; share: boolean }; watermark?: { text: string } | null }

/** `off`: no collaboration; otherwise the sync connection's state. */
export type CollabStatus = ConnectionState | 'off'

export type CollabState = {
  status: CollabStatus
  /** The room's document id, once known. */
  docId: string | null
  /** This person's role in the room, once joined. */
  role: Role | null
  /** The room's save state, in a managed room (KitCollab 1.4, managed-collab.md section 3); absent otherwise. */
  save?: SaveState | null
}

/**
 * A change of the document, and who made it: the person, the agent, or (`KitEmbed 1.8`, EM31) the
 * page itself through `commands.run` with `origin: 'system'`, with the `originLabel` it gave
 * (`host` when it gave none).
 */
export type DocumentChange = { dirty: boolean; revision: number; title: string } & ({ by: 'person' | 'agent' } | { by: 'system'; originLabel: string })

/**
 * `commands.run`'s options. `save: true` saves afterwards. `origin: 'system'` (`KitEmbed 1.8`,
 * EM31) runs the command as the page's own change on the person's behalf (a sync feature writing
 * into the open document), as Kit Process Protocol's `commands.execute` with origin `system` does on
 * a closed one: no undo step in any history, and the editor says the app made it. `originLabel`
 * names the page's feature (`emailsync`: 1 to 64 letters, digits, `.`, `_`, `-`; `host` when
 * absent). Without `origin` the command runs as the agent's step.
 */
export type EmbedRunOptions = { save?: boolean; origin?: 'system'; originLabel?: string }

/** A person in the room, with their name and avatar from `identity.users` when it knows them. */
export type EmbedPresence = Presence & { user?: EmbedUser }

/** One comment of a thread; `user` is its author as `identity.users` names them. */
export type EmbedComment = { id: string; author: string; name?: string; body: string; created: string; user?: EmbedUser }

/** A comment thread of the document (KitModel rule M23). */
export type EmbedCommentThread = { id: string; anchor: CommentAnchor | null; resolved: boolean; comments: EmbedComment[] }

/** The document's leases now, and which were taken and given up since the last report. */
export type EmbedLeases = { leases: KitLease[]; held: KitLease[]; released: KitLease[] }

/** One of the page's own buttons (`ui.add`) was pressed in the kit (Kit UI protocol `ui/action`). */
export type EmbedAction = { id: string; document: { path: string; dirty: boolean; revision: number } }

export type EmbedEvents = {
  /** The document was written to the storage. */
  saved: { version: string }
  /** The document changed (an edit, an undo, a save). */
  changed: DocumentChange
  /** Something failed after the editor opened (a collaboration step, the kit reopening). */
  error: Error
  collab: CollabState
  /** The people in the room, this person included. */
  presence: EmbedPresence[]
  /** A save was refused because the file changed elsewhere since it was read (nothing was overwritten). */
  conflict: EmbedConflictError
  /** A message the kit asks the page to show (Kit UI protocol `host/notify`). */
  notify: EmbedNotice
  /**
   * The document's unresolved conflict objects (Kit UI protocol `document/conflicts`): merges the
   * kit could not resolve by itself, kept in the document until someone resolves them.
   */
  mergeConflicts: KitConflict[]
  /**
   * A newer version of the kit edited the document (Kit UI protocol `document/schema`, KitModel
   * rule M5a): `reads` is the schema version this kit reads, `newestAuthor` the newer
   * one. The editor keeps working; tell the person and offer the newer kit.
   */
  newerKit: KitSchemaReport
  /**
   * The document's comment threads, oldest first, whenever they change (`KitEmbed 1.1`), first
   * when a listener is added. Heard only from an editor that keeps a replica (`model`,
   * `storage.replica`, or collaboration) of a kit that keeps comments.
   */
  comments: EmbedCommentThread[]
  /** The room's leases changed: someone took or gave up a scope (`KitEmbed 1.1`, co-editing only). */
  leases: EmbedLeases
  /** The agent's draft opened, changed, became ready, or closed (`KitEmbed 1.1`, Kit UI protocol `draft/changed`); review it with `editor.draft` (`KitEmbed 1.3`). */
  draft: DraftInfo
  /** One of the page's own buttons (`ui.add`) was pressed (`KitEmbed 1.1`). */
  action: EmbedAction
  /** The person changed what they hide (`KitEmbed 1.1`, with `ui.customize`). */
  customize: { hide: string[] }
  /** One of the page's shortcuts (`EmbedOptions.shortcuts`) was pressed in the kit (`KitEmbed 1.6`). */
  shortcut: EmbedShortcut
}

/** The agent's draft as the page reviews it (`editor.draft`, `KitEmbed 1.3`). */
export type EmbedDraft = {
  /** `none`, `open` (the agent works on it), or `ready` (the agent asked for review). */
  state: () => Promise<DraftInfo>
  /** What merging would change (`summary`), and both sides rendered (`before`, `after`: base64 PNGs or `null`). */
  compare: (options?: { maxSize?: number }) => Promise<DraftComparison>
  /** Takes the draft into the document as one undo step of the agent's (`origin`), then closes it. */
  merge: (options?: { label?: string }) => Promise<{ merged: boolean; summary: DraftSummary }>
  /** Closes the draft and leaves the document as it is. */
  discard: () => Promise<DraftInfo>
}

export type EmbedNotice = { level: 'info' | 'success' | 'warning' | 'error'; message: string; description?: string }

/** The `ModelPort` of `@kition/script`, given by an editor without depending on it. */
export type EmbedModelPort = {
  readonly kitId: string
  exportChanges: (since: Uint8Array) => Promise<Uint8Array>
  importChanges: (changes: Uint8Array) => Promise<void>
  command: (id: string, params: unknown) => Promise<unknown>
  commands: () => Promise<EmbedCommand[]>
  readOnly: () => boolean
  onChanged: (listener: (version: Uint8Array | null) => void) => () => void
  /** The editor's events `@kition/script` reports on its documents: `saved`, `conflict`, and `presence` when it co-edits. */
  events: ReadonlyArray<'saved' | 'presence' | 'conflict'>
  on: (event: 'saved' | 'presence' | 'conflict' | 'selection', listener: (value: never) => void) => () => void
  /**
   * The object model answered by the kit itself, when its editor lists the `model` capability:
   * each batch is then one undo step of the person's history. A refused batch rejects with an
   * error whose `data` is `{ code, index, message }`.
   */
  model?: {
    describe: (schema: object) => Promise<Record<string, unknown>>
    batch: (
      request: { origin?: unknown; ops?: Array<Record<string, unknown>>; load?: Array<Record<string, unknown>> },
      schema: object,
    ) => Promise<{ refs: Record<string, string>; results: unknown[]; loaded: Array<{ id: string; type: string; fields: Record<string, unknown> }>; version: Uint8Array | null }>
  }
}

export type EmbedCommand = { id: string; title: string; description?: string; enabled: boolean; schema?: unknown }

/** A kit's object-model typings as `@kition/script/kits/<kit>` exports them (`noteKit`): its id and schema. */
export type EmbedKitTypings = { id: string; schema: object }

export type EmbedEditor = {
  /** Resolves when the kit has rendered the document; rejects when it could not open it. */
  ready: () => Promise<void>
  /** Saves as the kit's own Save does; `saved` is false when there was nothing to write. */
  save: () => Promise<{ saved: boolean; version: string | null }>
  on: <E extends keyof EmbedEvents>(event: E, listener: (value: EmbedEvents[E]) => void) => () => void
  setTheme: (theme: EmbedTheme) => void
  setLocale: (locale: string) => void
  collab: {
    readonly state: CollabState
    /** A link to the room granting `role`, to hand to someone else. */
    shareLink: (role?: 'editor' | 'viewer') => Promise<string>
  }
  /** The kit's commands (its Kit AI bridge), until the document object model arrives. */
  commands: {
    list: (query?: string) => Promise<EmbedCommand[]>
    run: (id: string, params?: Record<string, unknown>, options?: EmbedRunOptions) => Promise<AiRunResult['completed'][number]>
  }
  /**
   * The document's replica version (its KDM version's bytes), or `null` when the kit keeps no
   * replica (a single-user editor without `storage.replica`). Two editors co-editing a document
   * hold the same changes when their versions name the same changes.
   */
  replicaVersion: () => Promise<Uint8Array | null>
  /**
   * The document as the object model reaches it (`@kition/script`: `openDocument(editor)` calls
   * this): its replica's changes and the kit's commands. Needs a replica (`model`, `storage.replica`,
   * or collaboration).
   */
  modelPort: () => EmbedModelPort
  /**
   * The document as `@kition/script`'s object model (`KitEmbed 1.1`): `openDocument` over
   * `modelPort()` in one call, with the object model bundled in this package. `kit` is the kit's
   * typings (`noteKit` of `@kition/script/kits/note`, whose root type is `Note`); they must be this
   * editor's kit's. Needs a replica, as `modelPort` does.
   */
  document: <Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap>(kit: EmbedKitTypings, options?: { origin?: Origin }) => Promise<ModelDocument<Root, C>>
  /** Replaces the `ui` option: what the kit's editor shows and allows (`KitEmbed 1.1`). */
  configure: (ui: EmbedUi) => void
  /** What the person may do now: the stricter of the options, the identity, and the room's role (`KitEmbed 1.1`). */
  readonly mode: PermissionMode
  /**
   * The kit's diagnostics on the open document (`KitEmbed 1.2`, KHP A21 and A22, KitAgent A23, `document/check`), errors
   * first; none from a kit that does not check.
   */
  check: (options?: { draft?: boolean }) => Promise<KitDiagnostic[]>
  /**
   * The agent's draft of the document (`KitEmbed 1.3`, Kit UI protocol section 7d), for the
   * person to review: the page shows `compare()` and calls `merge()` or `discard()` only on the
   * person's explicit action (a Merge or Discard button), never from an agent's or a model's
   * output (UI-D1). A kit without drafts answers `state: 'none'` and refuses the rest
   * (`EmbedError` `unsupported`); a person who may not edit cannot merge or discard (`read-only`).
   */
  draft: EmbedDraft
  /**
   * The open document as an MCP server for the integrator's agent (`KitEmbed 1.3`): the kit tools
   * of `kition-kits-mcp` (`<prefix>_inspect`, `_run`, `_check`, …) on this editor. The page
   * relays its messages to its server (`relayAgentPort`). The agent's edits go to a draft unless
   * `options.draft` is `false`; it can ask for review but never merge.
   */
  agentPort: (options?: AgentPortOptions) => AgentPort
  /**
   * Comment threads the page keeps (`KitEmbed 1.7`, EM30), with the `comments` option: `show` gives
   * the kit the whole list to mark (sent again to a kit opened again); `locate` answers whether the
   * kit finds each anchor now (all `false` from a kit without `comment-anchors`).
   */
  comments: {
    show: (threads: EmbedShownThread[]) => void
    locate: (anchors: EmbedCommentAnchor[]) => Promise<boolean[]>
  }
  /** Closes the editor and removes its frame; unsaved edits are dropped. */
  destroy: () => void
}
