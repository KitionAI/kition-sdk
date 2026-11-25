/** An editor refused or failed for a reason the page can act on; `code` names it. */
export class EmbedError extends Error {
  constructor(
    /**
     * `conflict`: see `EmbedConflictError`; `unsupported`: the kit does not offer it (drafts);
     * `read-only`: the person may not do it; `no-draft`: there is no draft to merge or discard.
     */
    readonly code: 'conflict' | 'unsupported' | 'read-only' | 'no-draft',
    message: string,
  ) {
    super(message)
    this.name = 'EmbedError'
  }
}

/** A write refused because the file changed since the editor read it (its version moved on). */
export class EmbedConflictError extends EmbedError {
  constructor(readonly fileId: string, readonly currentVersion: string | null = null) {
    super('conflict', `${fileId} changed elsewhere since it was opened`)
    this.name = 'EmbedConflictError'
  }
}
