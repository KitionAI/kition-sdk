/**
 * Focus mode's floating bar: Exit focus (named, with its key), Undo, Ask (when the host has an
 * agent), and the active tool. It shows in full for a few seconds on entering Focus, so the way
 * out is seen, then fades until hovered or focused.
 */
import { useEffect, useState } from 'react'
import { Minimize2Icon as Minimize2, SparklesIcon as Sparkles, Undo2Icon as Undo2, type IconComponent } from '@kition/tessera-icons/react'
import { useHistoryState, useKitEditor, useKitTools } from '../editor'
import { toolIcon } from '../toolIcons'
import { Button, ICON_STROKE, IconButton } from '@kition/tessera-ui'
import { useUi } from '../uiContext'

/** The tool the Focus bar names (a kit's own rail passes it; the engine's active tool otherwise). */
export type FocusTool = { label: string; icon: IconComponent }

/** How long the bar shows in full after entering Focus. */
const FRESH_MS = 4000

export function FocusBar({ tool, onExit }: { tool?: FocusTool | null; onExit: () => void }) {
  const editor = useKitEditor()
  const tools = useKitTools()
  const ui = useUi()
  const { undo } = useHistoryState()
  const { host, t, testId, phrase } = editor
  const engine = tools?.tools.find((item) => item.id === tools.active)
  const shown = tool ?? (engine ? { label: phrase(engine.label), icon: toolIcon(engine.icon, engine.id) } : null)
  const agent = ui.state('action:agent')
  const ToolIcon = shown?.icon
  const [fresh, setFresh] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setFresh(false), FRESH_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="kui-focus-bar" role="toolbar" aria-label={t('focusBar')} data-fresh={fresh || undefined} data-testid={`${testId}-focus-bar`}>
      <Button variant="ghost" className="kui-focus-exit" title={`${t('exitFocus')} (Esc)`} onClick={onExit} data-testid={`${testId}-focus-exit`} data-kit-ui-id="action:mode">
        <Minimize2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('exitFocus')}
        <kbd>Esc</kbd>
      </Button>
      {undo.hidden ? null : <IconButton icon={Undo2} label={t('undo')} disabled={undo.disabled} onClick={() => void editor.run('edit.undo', {})} data-testid={`${testId}-focus-undo`} data-kit-ui-id="action:undo" />}
      {host.init.capabilities.includes('agent') && !agent.hidden ? <IconButton icon={Sparkles} label={t('askAgent')} disabled={agent.disabled} onClick={() => void host.openAgent()} data-testid={`${testId}-focus-ask`} data-kit-ui-id="action:agent" /> : null}
      {shown && ToolIcon ? (
        <span className="kui-focus-tool" data-testid={`${testId}-focus-tool`}>
          <ToolIcon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {shown.label}
        </span>
      ) : null}
    </div>
  )
}
