/**
 * Where a kit draws its comment markers (KitModel rule M23): the kit tells where
 * each thread's anchor is on screen (`locate`: an object's box, a text range's caret rectangle),
 * and gets one marker per thread it could place, with what to draw (resolved or not, how many
 * comments) and which one is active. Threads whose anchor is gone (a deleted object, a quote no
 * longer in the text) have no marker; the panel still lists them.
 */
import { useMemo } from 'react'
import type { CommentAnchor, CommentThread } from '@kition/kdm'

export type CommentMarkerRect = { x: number; y: number; width: number; height: number }

export type CommentMarker = {
  thread: string
  anchor: CommentAnchor
  rect: CommentMarkerRect
  resolved: boolean
  count: number
  active: boolean
}

export type CommentAnchorsOptions = {
  threads: CommentThread[]
  /** Where `anchor` is now, in the kit's own coordinates; `null` when it is not shown. */
  locate: (anchor: CommentAnchor) => CommentMarkerRect | null
  /** Markers for resolved threads too (default: only open ones). */
  showResolved?: boolean
  activeThread?: string | null
  /** Changes whenever what `locate` answers may have changed (a document revision, the zoom). */
  revision?: unknown
}

/** The markers to draw, in the threads' order. */
export function commentMarkers({ threads, locate, showResolved = false, activeThread = null }: CommentAnchorsOptions): CommentMarker[] {
  const markers: CommentMarker[] = []
  for (const thread of threads) {
    if (!thread.anchor || (thread.resolved && !showResolved)) continue
    const rect = locate(thread.anchor)
    if (!rect) continue
    markers.push({ thread: thread.id, anchor: thread.anchor, rect, resolved: thread.resolved, count: thread.comments.length, active: thread.id === activeThread })
  }
  return markers
}

/** `commentMarkers`, kept while its inputs (and `revision`) stay the same. */
export function useCommentAnchors(options: CommentAnchorsOptions): CommentMarker[] {
  const { threads, locate, showResolved, activeThread, revision } = options
  return useMemo(() => commentMarkers({ threads, locate, showResolved, activeThread }), [threads, locate, showResolved, activeThread, revision])
}
