/**
 * The display mode button (`action:mode`): the chosen mode's icon, marked when the frame stepped
 * down to fit; its menu lists the allowed modes. In a frame without tabs (`areas` false) it is a
 * Focus button: the other modes draw the same there.
 */
import { FocusIcon as Focus, MenuIcon as Menu, PanelTopIcon as PanelTop, RectangleHorizontalIcon as RectangleHorizontal, type IconComponent } from '@kition/tessera-icons/react'
import { useKitEditor } from '../editor'
import { isMac } from '../host'
import { ICON_STROKE, IconButton, MenuButton, MenuItem } from '@kition/tessera-ui'
import { useUi } from '../uiContext'
import type { DisplayMode } from './modes'
import type { DisplayModeState } from './useFrameLayout'

const MODE_ICONS: Record<DisplayMode, IconComponent> = { menus: Menu, line: RectangleHorizontal, classic: PanelTop, focus: Focus }

/** Focus's key as the menus write shortcuts (`Cmd` on macOS, `Ctrl` elsewhere). */
const FOCUS_SHORTCUT = () => (isMac() ? 'Cmd+\\' : 'Ctrl+\\')

export function ModeButton({ display, shown, areas = true }: { display: DisplayModeState; shown: DisplayMode; areas?: boolean }) {
  const { t, testId } = useKitEditor()
  const ui = useUi()
  const state = ui.state('action:mode')
  if (state.hidden || display.allowed.length < 2) return null
  if (!areas) {
    const label = `${t('mode_focus')} (${FOCUS_SHORTCUT()})`
    return <IconButton icon={Focus} label={label} className="kui-mode-button" disabled={state.disabled} onClick={() => display.choose('focus')} data-testid={`${testId}-mode-focus`} data-kit-ui-id="action:mode" />
  }
  const Icon = MODE_ICONS[display.chosen]
  const stepped = shown !== display.chosen
  const label = stepped ? t('modeStepped', { mode: t(`mode_${display.chosen}`), shown: t(`mode_${shown}`) }) : t('modeButton', { mode: t(`mode_${display.chosen}`) })
  return (
    <MenuButton
      align="end"
      trigger={({ toggle, open }) => (
        <button type="button" className="kui-icon-button kui-mode-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} data-stepped={stepped || undefined} disabled={state.disabled} onClick={toggle} data-testid={`${testId}-mode`} data-kit-ui-id="action:mode">
          <Icon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      )}
    >
      {display.allowed.map((mode) => (
        <MenuItem key={mode} icon={MODE_ICONS[mode]} label={t(`mode_${mode}`)} shortcut={mode === 'focus' ? FOCUS_SHORTCUT() : null} checked={mode === display.chosen} onSelect={() => display.choose(mode)} testId={`${testId}-mode-${mode}`} uiId="action:mode" />
      ))}
    </MenuButton>
  )
}
