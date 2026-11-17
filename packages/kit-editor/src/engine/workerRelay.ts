/**
 * The relay between a kit editor's page replica and its engine worker's replica. A kit whose
 * editor edits a KDM replica in the page (typing never waits for the worker) keeps it in step with
 * the worker's, which the host saves, co-edits through, and runs agents, comments, and scripts on.
 */
import type { Replica, Version } from '@kition/kdm'

/** The engine worker's replica, as the document session exposes it (`useKitSession().replica`). */
export type EngineReplica = {
  exportChanges(since: ArrayBuffer): Promise<{ changes: ArrayBuffer; blobs: ArrayBuffer }>
  importChanges(changes: ArrayBuffer, blobs: ArrayBuffer): Promise<unknown>
}

/**
 * The page side of a relay when it is more than a replica: a store whose replica may be replaced
 * (a pull that finds another replica than it started with drops what it fetched), or that applies
 * the worker's changes itself so it can refresh its own view.
 */
export type WorkerRelayPage = {
  /** The page's replica now. */
  replica(): Replica
  /** Applies the worker's changes to the page's replica (default: `replica().importChanges`). */
  importChanges?(changes: Uint8Array): void
}

export type WorkerRelayOptions = {
  /** Called with an exchange's error; the relay goes on with the next one. Default: `console.error`. */
  report?: (error: unknown) => void
  /** Called after changes from the worker reached the page's replica. */
  pulled?: () => void
}

const NO_BLOBS = new ArrayBuffer(0)

/** The bytes of `view` as an `ArrayBuffer` of their own (the worker takes it). */
function own(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer
}

function isReplica(page: Replica | WorkerRelayPage): page is Replica {
  return typeof (page as WorkerRelayPage).replica !== 'function'
}

/**
 * Keeps the page's replica and the engine worker's replica of one document in step. Both are KDM
 * replicas with their own actors, so each takes the other's changes as it would a collaborator's:
 * the page's edits go to the worker (`push`, after each local transaction), and whatever the
 * worker took from elsewhere (engine commands, co-editors, agents, external file merges) comes to
 * the page (`pull`, when the session reports a change). Exchanges run one at a time, in order.
 *
 * A pull reads the page's version only after the worker answered: the person may type while it
 * waits, and those edits are not the worker's yet (an edit typed during a pull used to be taken as
 * the worker's and never sent; WebKit lost it every time).
 */
export class WorkerRelay {
  private queue: Promise<void> = Promise.resolve()
  /** The page's changes the worker has, as far as the page knows. */
  private pushed: Version
  private closed = false
  private readonly page: WorkerRelayPage
  private readonly report: (error: unknown) => void
  private readonly pulled: () => void

  constructor(
    page: Replica | WorkerRelayPage,
    private readonly engine: EngineReplica,
    options: WorkerRelayOptions = {},
  ) {
    this.page = isReplica(page) ? { replica: () => page } : page
    this.report = options.report ?? ((error) => console.error('[kit] the page and engine replicas could not exchange changes', error))
    this.pulled = options.pulled ?? (() => {})
    this.pushed = this.page.replica().version()
  }

  /** Sends the page's edits the worker does not have yet. */
  push(): void {
    this.enqueue(async () => {
      const replica = this.page.replica()
      const version = replica.version()
      if (this.pushed.includes(version)) return
      await this.engine.importChanges(own(replica.exportChanges(this.pushed)), NO_BLOBS)
      this.pushed = version
    })
  }

  /** Takes the worker's changes the page does not have yet. */
  pull(): void {
    this.enqueue(async () => {
      const replica = this.page.replica()
      const { changes } = await this.engine.exportChanges(own(replica.version().encode()))
      if (this.closed || this.page.replica() !== replica) return
      // Read after the wait: the person may have typed meanwhile, and those edits are not the
      // worker's yet. Unless the page edited since its last push, the worker now has all it has.
      const before = replica.version()
      const caughtUp = this.pushed.includes(before)
      const bytes = new Uint8Array(changes)
      if (this.page.importChanges) this.page.importChanges(bytes)
      else replica.importChanges(bytes)
      if (caughtUp) this.pushed = replica.version()
      if (!replica.version().equals(before)) this.pulled()
    })
  }

  /** Stops the relay: exchanges not started yet are dropped. */
  close(): void {
    this.closed = true
  }

  /** Waits for the exchanges asked for so far. */
  settled(): Promise<void> {
    return this.queue
  }

  private enqueue(step: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.closed) return
      try {
        await step()
      } catch (error) {
        this.report(error)
      }
    })
  }
}
