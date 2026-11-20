/**
 * The agent's drafts in the gateway's editor page with the real Note kit (sdk.gateway.draft-review,
 * decision R9): a real `kition gateway` and a real relayed `kition mcp`; the agent's draft of the
 * open file is headless, the banner appears, the review shows the change, Merge writes it and the
 * editor shows it, Discard drops one, a `stale` draft needs "Merge and overwrite"; the review view
 * works on its own address too.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { inspected, noteSample, opened, proxied, setup, shots, watch } from './page'
import { McpClient, startGateway, startProxy } from './helpers'

test.beforeAll(() => fs.mkdirSync(shots, { recursive: true }))

/** Waits until the draft banner says `state` (or is gone with `null`). */
async function banner(page: Page, state: 'open' | 'ready' | null) {
  const element = page.getByTestId('draft-banner')
  if (state === null) await expect(element).toBeHidden()
  else await expect(element).toHaveAttribute('data-state', state)
}

test('an agent draft on an open file is headless: the banner, the review, merge into the editor, discard, and a stale draft needing overwrite', async ({ page }) => {
  const { home, workspace } = await setup('drafts', ['note'])
  const file = path.join(workspace, 'plan.md')
  fs.writeFileSync(file, noteSample())
  const gateway = await startGateway(home, workspace)
  const proxy = await startProxy(gateway.url, gateway.token)
  const agent = new McpClient(home, workspace)
  const draft = (markdown: string) => agent.call('kit_run', { path: 'plan.md', draft: true, steps: [{ command: 'block.append', params: { markdown } }] })
  try {
    const problems = watch(page)
    await page.goto(proxied(proxy.url, 'plan.md'))
    await opened(page)
    await agent.initialize()
    const original = fs.readFileSync(file, 'utf8')

    // A draft: headless, the file and the editor unchanged, the banner shown.
    await draft('Drafted by the agent.')
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(await inspected(page)).not.toContain('Drafted by the agent.')
    await banner(page, 'open')
    await agent.call('kit_draft_ready', { path: 'plan.md' })
    await banner(page, 'ready')
    await page.screenshot({ path: path.join(shots, 'draft-banner.png') })

    // The review: the change, both pictures; Merge writes it and the editor shows it.
    await page.getByTestId('draft-review-open').click()
    const review = page.getByTestId('draft-comparison')
    await expect(review).toBeVisible({ timeout: 60_000 })
    await expect(review).toContainText('Drafted by the agent.')
    await expect(page.getByTestId('draft-before').locator('img')).toBeVisible()
    await expect(page.getByTestId('draft-after').locator('img')).toBeVisible()
    await page.screenshot({ path: path.join(shots, 'draft-review.png') })
    await page.getByTestId('draft-merge').click()
    await expect(page.getByTestId('toast-success')).toBeVisible()
    expect(fs.readFileSync(file, 'utf8')).toContain('Drafted by the agent.')
    await expect.poll(() => inspected(page), { timeout: 30_000 }).toContain('Drafted by the agent.')
    await banner(page, null)
    await page.screenshot({ path: path.join(shots, 'draft-merged.png') })

    // Discard: the draft goes, the file stays.
    await draft('A draft to discard.')
    await banner(page, 'open')
    const kept = fs.readFileSync(file, 'utf8')
    await page.getByTestId('draft-review-open').click()
    await expect(page.getByTestId('draft-comparison')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('draft-discard').click()
    await banner(page, null)
    expect(fs.readFileSync(file, 'utf8')).toBe(kept)
    const listed = (await (await fetch(`${proxy.url}api/v1/kits/drafts`)).json()) as { data: { drafts: unknown[] } }
    expect(listed.data.drafts).toEqual([])

    // A stale draft: the file changed after the draft forked; Merge is refused until overwrite is chosen.
    await draft('A late draft.')
    await banner(page, 'open')
    fs.writeFileSync(file, `${kept}\nThe person wrote this meanwhile.\n`)
    // The review on its own address (a host may open it in a tab of its own).
    const reviewPage = await page.context().newPage()
    await reviewPage.goto(proxied(proxy.url, 'plan.md', 'review'))
    await expect(reviewPage.getByTestId('draft-stale')).toBeVisible({ timeout: 60_000 })
    await expect(reviewPage.getByTestId('draft-merge')).toBeHidden()
    await reviewPage.screenshot({ path: path.join(shots, 'draft-review-stale.png') })
    await reviewPage.getByTestId('draft-overwrite').click()
    await expect(reviewPage.getByTestId('toast-success')).toBeVisible()
    expect(fs.readFileSync(file, 'utf8')).toContain('A late draft.')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('The person wrote this meanwhile.')
    await reviewPage.close()
    await banner(page, null)
    expect(problems, problems.join('\n')).toEqual([])
  } finally {
    agent.stop()
    proxy.stop()
    await gateway.stop()
  }
})

