/**
 * A kit says why a command did not run by a typed reason (`kition_kit::failure`: its text, U+001F,
 * the reason), which the page reads as the reason and never shows.
 */
import { describe, expect, it } from 'vitest'
import { KitCommandFailure, commandFailure } from './refusal'

describe('a command failure', () => {
  it('carries its reason and shows its text alone', () => {
    const failure = commandFailure(new Error('the label is locked\u001fcommand_disabled'))
    expect(failure).toBeInstanceOf(KitCommandFailure)
    expect(failure?.reason).toBe('command_disabled')
    expect(failure?.message).toBe('the label is locked')
    expect(commandFailure(new Error('unknown command `x`'))).toBeNull()
    expect(commandFailure('a reason we do not know\u001fsomething')).toBeNull()
  })
})
