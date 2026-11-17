import type { ModelDocument } from '@kition/script'

export type ReviewResult = {
  heading: string
  level: number
  task: { text: string; checked: boolean }
  text: string
}

/** Adds a review section with a task, puts "Q3 " before its heading, and checks the task off. */
export function quarterlyReview(note: ModelDocument<any, any>): Promise<ReviewResult>
