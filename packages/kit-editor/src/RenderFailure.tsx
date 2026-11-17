import { Button } from '@kition/tessera-ui'

/** A render failure stays visible while the live canvas remains available for navigation. */
export function RenderFailure({ message, title, retryLabel, onRetry }: { message: string; title: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div className="kui-render-failure" role="alert" data-testid="kit-render-failure">
      <div><strong>{title}</strong><div className="kui-muted">{message}</div></div>
      <Button onClick={onRetry}>{retryLabel}</Button>
    </div>
  )
}
