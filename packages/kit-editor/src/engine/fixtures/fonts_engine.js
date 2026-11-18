/**
 * A `ts-worker` engine module for the lazy fonts' tests: it takes fonts (`addFont`, recording each
 * file's text) and says when text wanted a face it has not got (`wantsFonts`, set by `want()`);
 * its documents are the notes fixture's.
 */
export { NotesDocument } from './notes_engine.js'

export const added = []
const state = { wanted: false }

export default async function prepare() {}

export function addFont(bytes) {
  added.push(new TextDecoder().decode(bytes))
  return 1
}

export function wantsFonts() {
  const wanted = state.wanted
  state.wanted = false
  return wanted
}

/** What laying out text with a character no face covers does in a real engine. */
export function want() {
  state.wanted = true
}
