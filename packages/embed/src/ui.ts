/**
 * The page's `ui` option as the Kit UI protocol's UI configuration (section 9), what a person may
 * do as one mode, and the people the page names (`KitEmbed 1.1`).
 */
import type { KitUiConfig, KitUiElement } from '@kition/kit-ui-protocol'
import type { EmbedComment, EmbedCommentThread, EmbedPresence, EmbedUi, EmbedUser, IdentityProvider, PermissionMode, Presence } from './types'

const RANK: Record<PermissionMode, number> = { view: 0, comment: 1, edit: 2 }

/** The stricter of the modes given; `edit` when none is. */
export function strictestMode(...modes: Array<PermissionMode | null | undefined>): PermissionMode {
  let mode: PermissionMode = 'edit'
  for (const next of modes) if (next && next in RANK && RANK[next] < RANK[mode]) mode = next
  return mode
}

/** A `panels` entry as a `panel:` id. */
const panelId = (panel: string) => (panel.startsWith('panel:') ? panel : `panel:${panel}`)

/**
 * The configuration the kit is sent: the protocol's members of `ui` as they are, `toolbar: 'none'`
 * as hidden ribbon tabs, the panels `panels` leaves out (once the kit has listed its elements),
 * and the person's own hides (`personal`, the latest `host/customize`).
 */
export function kitUiConfig(ui: EmbedUi | undefined, elements: KitUiElement[] | null, personal: { hide?: string[] } | null): KitUiConfig | undefined {
  if (!ui && !personal) return undefined
  const hide = [...(ui?.hide ?? [])]
  if (ui?.toolbar === 'none') hide.push('tab:*')
  if (ui?.panels && elements) {
    const kept = new Set(ui.panels.map(panelId))
    for (const element of elements) if (element.kind === 'panel' && !kept.has(element.id)) hide.push(element.id)
  }
  const config: KitUiConfig = {}
  if (hide.length) config.hide = [...new Set(hide)]
  if (ui?.disable?.length) config.disable = [...ui.disable]
  if (ui?.add?.length) config.add = ui.add
  if (ui?.modes) config.modes = { ...ui.modes }
  const own = personal ?? ui?.personal
  if (own?.hide) config.personal = { hide: [...own.hide] }
  return config
}

/** Names people by id through `identity.users`, asking for each id once. */
export class People {
  private readonly known = new Map<string, Promise<EmbedUser | null>>()

  constructor(private readonly identity: IdentityProvider | undefined) {}

  get serves() {
    return Boolean(this.identity?.users)
  }

  /** The people `identity.users` knows among `ids`. */
  async lookup(ids: string[]): Promise<Map<string, EmbedUser>> {
    const users = this.identity?.users
    const found = new Map<string, EmbedUser>()
    if (!users) return found
    const fresh = [...new Set(ids.filter((id) => id && !this.known.has(id)))]
    if (fresh.length) {
      const answered = Promise.resolve()
        .then(() => users(fresh))
        .then(
          (list) => new Map((Array.isArray(list) ? list : []).filter((user) => user && typeof user.id === 'string').map((user) => [user.id, user])),
          (error: unknown) => {
            console.warn('[kition-embed] identity.users failed', error)
            return new Map<string, EmbedUser>()
          },
        )
      for (const id of fresh) this.known.set(id, answered.then((map) => map.get(id) ?? null))
    }
    for (const id of new Set(ids)) {
      const user = await this.known.get(id)
      if (user) found.set(id, user)
    }
    return found
  }

  /** The room's peers with the page's names and avatars for them: by the user their presence names, else their principal. */
  async presence(peers: Presence[]): Promise<EmbedPresence[]> {
    return namePeers(peers, this.serves ? await this.lookup(peers.map(peerUserId)) : new Map())
  }

  /** The threads with each comment's author as the page names them. */
  async threads(threads: Array<Omit<EmbedCommentThread, 'comments'> & { comments: EmbedComment[] }>): Promise<EmbedCommentThread[]> {
    const users = await this.lookup(threads.flatMap((thread) => thread.comments.map((comment) => comment.author)))
    return threads.map((thread) => ({
      ...thread,
      comments: thread.comments.map((comment) => {
        const user = users.get(comment.author)
        return user ? { ...comment, user } : { ...comment }
      }),
    }))
  }
}

/** The user a peer's presence names (`@kition/embed` sets `{ kit, user }`), when it does. */
function ownUser(peer: Presence): EmbedUser | undefined {
  const user = (peer.state as { user?: unknown } | null)?.user as EmbedUser | undefined
  return user && typeof user.id === 'string' && typeof user.name === 'string' ? user : undefined
}

const peerUserId = (peer: Presence) => ownUser(peer)?.id ?? peer.principalId

/** Peers with `user`: as `users` names them, else as their own presence does. */
export function namePeers(peers: Presence[], users: Map<string, EmbedUser>): EmbedPresence[] {
  return peers.map((peer) => {
    const named = users.get(peerUserId(peer)) ?? users.get(peer.principalId)
    const user = named ?? ownUser(peer)
    return user ? { ...peer, name: named?.name || peer.name, user } : { ...peer }
  })
}
