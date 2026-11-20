// The person's reviews of agents' drafts, kept with the workspace (`.kition/dsh-reviews.json`, beside
// the drafts the gateway keeps there): every Merge, Merge and overwrite or Discard that passes the
// host module's proxy (a review card's, or the editor page's own review) is one record — the file,
// what was done, when, that it was the person signed in to DeepSeek Harness, and, from a card, the
// session and turn it belongs to. Every browser reads the same records, so a review card shows what
// was done wherever it was done; a draft merged or discarded outside DeepSeek Harness leaves no
// record, and its card says only that the draft is no longer there.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The most records kept per workspace; the oldest go first. */
export const KEPT = 1000

export const reviewsFile = (workspace) => path.join(workspace, '.kition', 'dsh-reviews.json')

/** The records of `workspace`, oldest first; none when there are none or they cannot be read. */
export function readReviews(workspace) {
  try {
    const kept = JSON.parse(fs.readFileSync(reviewsFile(workspace), 'utf8'))
    return Array.isArray(kept?.reviews) ? kept.reviews : []
  } catch {
    return []
  }
}

/**
 * Adds a record to `workspace`'s, written whole and renamed into place.
 * @param {string} workspace
 * @param {{ path: string, outcome: 'merged' | 'discarded', overwrite?: boolean, session?: string | null, turn?: number | null }} review
 */
export function recordReview(workspace, review) {
  const record = {
    path: review.path,
    outcome: review.outcome,
    ...(review.overwrite ? { overwrite: true } : {}),
    by: 'person',
    at: Date.now(),
    session: typeof review.session === 'string' && review.session ? review.session : null,
    turn: Number.isSafeInteger(review.turn) ? review.turn : null,
  }
  const file = reviewsFile(workspace)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const reviews = [...readReviews(workspace), record].slice(-KEPT)
  const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({ format: 1, reviews }, null, 1)}\n`)
  fs.renameSync(temporary, file)
  return record
}
