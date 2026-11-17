/** The host's buttons (protocol section 9) where a shared container draws them. */
import { BellIcon as Bell, CheckIcon as Check, CircleQuestionMarkIcon as CircleHelp, DownloadIcon as Download, EyeIcon as Eye, FlagIcon as Flag, InfoIcon as Info, LinkIcon as Link, LockIcon as Lock, MailIcon as Mail, MessageSquareIcon as MessageSquare, PlusIcon as Plus, PrinterIcon as Printer, SendIcon as Send, SettingsIcon as Settings, Share2Icon as Share2, SquareIcon as Square, StarIcon as Star, UploadIcon as Upload, XIcon as X, type IconComponent } from '@kition/tessera-icons/react'
import { Button, ICON_STROKE, MenuItem, RibbonButton } from '@kition/tessera-ui'
import { useUi } from './uiContext'
import { buttonLabel } from './uiConfig'

/** The icon names a host may give its buttons; an unknown name shows a plain square. */
export const HOST_ICONS: Record<string, IconComponent> = {
  bell: Bell,
  check: Check,
  download: Download,
  eye: Eye,
  flag: Flag,
  help: CircleHelp,
  info: Info,
  link: Link,
  lock: Lock,
  mail: Mail,
  message: MessageSquare,
  plus: Plus,
  printer: Printer,
  send: Send,
  settings: Settings,
  share: Share2,
  star: Star,
  upload: Upload,
  x: X,
}

const images = new Map<string, IconComponent>()

/** The most `data:` icons kept drawn as images at once; the least recently used is dropped to make room for a new one. */
const MAX_IMAGE_ICONS = 32

/** A host icon as an icon component: a name from `HOST_ICONS`, or a `data:image/…` URL drawn as an image (it runs no script). `Object.hasOwn` keeps a name such as `constructor` or `__proto__` from resolving to an inherited property instead of a plain square. */
export function hostIcon(icon: string | undefined): IconComponent | undefined {
  if (!icon) return undefined
  if (!icon.startsWith('data:image/')) return Object.hasOwn(HOST_ICONS, icon) ? HOST_ICONS[icon] : Square
  const image = images.get(icon)
  if (image) {
    images.delete(icon)
    images.set(icon, image)
    return image
  }
  if (images.size >= MAX_IMAGE_ICONS) {
    const oldest = images.keys().next().value
    if (oldest !== undefined) images.delete(oldest)
  }
  const made = (({ size = 16 }: { size?: number }) => <img src={icon} width={size} height={size} alt="" aria-hidden="true" />) as unknown as IconComponent
  images.set(icon, made)
  return made
}

/** The host buttons at `place`, as menu items, ribbon buttons, or document action buttons. */
export function HostButtons({ place, as }: { place: string; as: 'menu' | 'ribbon' | 'action' }) {
  const ui = useUi()
  return (
    <>
      {ui.buttons(place).map((item) => {
        const label = buttonLabel(item, ui.locale)
        const Icon = hostIcon(item.icon)
        const uiId = `host:${item.id}`
        if (as === 'menu') return <MenuItem key={item.id} icon={Icon} label={label} shortcut={item.shortcut} disabled={item.disabled} onSelect={() => ui.press(item.id)} uiId={uiId} />
        if (as === 'ribbon') return <RibbonButton key={item.id} icon={Icon} label={label} pressed={item.pressed} disabled={item.disabled} onClick={() => ui.press(item.id)} data-kit-ui-id={uiId} />
        return (
          <Button key={item.id} variant="ghost" aria-pressed={item.pressed} disabled={item.disabled} onClick={() => ui.press(item.id)} data-kit-ui-id={uiId}>
            {Icon ? <Icon size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /> : null}
            {label}
          </Button>
        )
      })}
    </>
  )
}
