import { describe, expect, it } from 'vitest'
import { BoldIcon, BrushIcon, MousePointerClickIcon, CameraIcon, LightbulbIcon, PlusIcon, CommandGenericIcon, FileOutputIcon, LayersIcon, MergeIcon, PilcrowIcon, TableIcon, TrashIcon, Undo2Icon } from '@kition/tessera-icons/react'
import { COMMAND_FALLBACK_ICON, commandIcon, registerCommandIcons } from './toolIcons'

describe('commandIcon', () => {
  it('reads the verb first, so an action is never drawn as its object', () => {
    expect(commandIcon({ id: 'edit.undo' })).toBe(Undo2Icon)
    expect(commandIcon({ id: 'layer.mergeDown' })).toBe(MergeIcon)
    expect(commandIcon({ id: 'table.delete', title: 'Delete Table' })).toBe(TrashIcon)
    expect(commandIcon({ id: 'file.exportPdf' })).toBe(FileOutputIcon)
    expect(commandIcon({ id: 'html.click' })).toBe(MousePointerClickIcon)
  })

  it('shows what a creating command makes', () => {
    expect(commandIcon({ id: 'layer.newCamera', title: 'Camera' })).toBe(CameraIcon)
    expect(commandIcon({ id: 'layer.newLight', title: 'Light' })).toBe(LightbulbIcon)
    expect(commandIcon({ id: 'thing.add', title: 'Add' })).toBe(PlusIcon)
  })

  it('reads the title when the id has no verb', () => {
    expect(commandIcon({ id: 'x.y', title: 'Export as PNG' })).toBe(FileOutputIcon)
  })

  it('falls back to the object, then to the specific words', () => {
    expect(commandIcon({ id: 'paint.brushSettings' })).toBe(BrushIcon)
    expect(commandIcon({ id: 'format.paragraphSpacing' })).toBe(PilcrowIcon)
    expect(commandIcon({ id: 'layers.panel' })).toBe(LayersIcon)
    expect(commandIcon({ id: 'cells.pivotTable' })).not.toBe(TableIcon)
  })

  it('draws a neutral mark for a command nothing matches, never the selection icon', () => {
    expect(commandIcon({ id: 'x' })).toBe(COMMAND_FALLBACK_ICON)
    expect(COMMAND_FALLBACK_ICON).toBe(CommandGenericIcon)
  })

  it("takes a kit's own icon for a command over every rule", () => {
    registerCommandIcons({ 'edit.undo': BoldIcon, 'cad.dimaligned': BrushIcon })
    expect(commandIcon({ id: 'edit.undo' })).toBe(BoldIcon)
    expect(commandIcon({ id: 'cad.dimaligned', title: 'Aligned' })).toBe(BrushIcon)
    registerCommandIcons({ 'edit.undo': Undo2Icon })
  })
})
