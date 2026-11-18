/**
 * A kit engine's lazy fonts (engine contract E9, kit-editor's manifest `lazyFonts`): faces the
 * engine is given after its document opens, so the first frame waits only for the manifest's
 * `fonts` (the primary face). They load in the order the manifest lists them, once the engine says
 * it wants a face it does not have (the optional module function `wantsFonts()`), or right after
 * the document opens when the engine cannot say. One file failing to load is skipped.
 */

/** A font file's bytes given to the engine (`addFont`); answers how many faces it added, or their family. */
export type AddFont = (bytes: Uint8Array) => unknown

/** Fetches a font file's bytes; null when it cannot be read. */
export type FetchFont = (url: string) => Promise<Uint8Array | null>

async function fetchFont(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(new URL(url, globalThis.location.href))
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

export class LazyFonts {
  private readonly left: string[]
  private loading: Promise<void> | null = null
  private readonly listeners = new Set<(pending: number) => void>()

  /** `addFont` null: the engine takes no fonts, so there is nothing to load. */
  constructor(
    urls: readonly string[],
    private readonly addFont: AddFont | null,
    private readonly wantsFonts: (() => boolean) | null,
    private readonly read: FetchFont = fetchFont,
  ) {
    this.left = addFont ? [...urls] : []
  }

  /** How many of the lazy fonts the engine has not been given yet (still to load, or loading). */
  get pending(): number {
    return this.left.length
  }

  /** Calls `listener` with `pending` after each font was given to the engine (or skipped); answers how to stop. */
  onSettled(listener: (pending: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Starts loading when fonts are left, none is loading, and the engine wants a face (or cannot
   * say). Call it after every request the engine answered: it asks the engine at most once per
   * call, and not at all once loading started.
   */
  check(): void {
    if (this.loading || this.left.length === 0) return
    let wanted = true
    try {
      wanted = this.wantsFonts?.() ?? true
    } catch {
      // An engine that cannot answer is treated as one that cannot say.
    }
    if (wanted) void this.loadAll()
  }

  /** Gives the engine every lazy font now, in order; resolves once each was given or skipped. */
  loadAll(): Promise<void> {
    if (!this.loading) this.loading = this.left.length ? this.load() : Promise.resolve()
    return this.loading
  }

  private async load() {
    while (this.left.length) {
      const bytes = await this.read(this.left[0])
      if (bytes) {
        try {
          this.addFont!(bytes)
        } catch {
          // Not a font the engine reads: its script stays in the faces it has.
        }
      }
      this.left.shift()
      for (const listener of this.listeners) listener(this.left.length)
    }
  }
}
