/**
 * A read that keeps one request in flight: asked while a read runs, it runs once more after that
 * read (however many times it was asked meanwhile), so the last answer always follows the last
 * ask. Every ask answers when the read that covers it has finished. A failed read is reported to
 * `onError` (or ignored) and does not stop the next one.
 */
export function oneInFlight(read: () => Promise<void>, onError?: (error: unknown) => void): () => Promise<void> {
  let running: Promise<void> | null = null
  let again = false
  return () => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          try {
            await read()
          } catch (error) {
            onError?.(error)
          }
        } while (again)
      } finally {
        running = null
      }
    })()
    return running
  }
}
