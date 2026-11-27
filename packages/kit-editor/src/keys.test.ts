// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isField } from './editor'
import { composingKey } from './host'
import { keyCode } from './engine/engineTools'

describe('isField', () => {
  it('takes text inputs, selects, and text areas as fields', () => {
    for (const type of ['text', 'number', 'search', 'email', 'password']) {
      const input = document.createElement('input')
      input.type = type
      expect(isField(input)).toBe(true)
    }
    expect(isField(document.createElement('select'))).toBe(true)
    expect(isField(document.createElement('textarea'))).toBe(true)
  })

  it('leaves keys on checkboxes, radios, buttons, ranges, and the text sink to the shortcuts', () => {
    for (const type of ['checkbox', 'radio', 'button', 'range', 'color']) {
      const input = document.createElement('input')
      input.type = type
      expect(isField(input)).toBe(false)
    }
    const sink = document.createElement('textarea')
    sink.classList.add('kui-text-sink')
    expect(isField(sink)).toBe(false)
    expect(isField(document.createElement('div'))).toBe(false)
  })
})

describe('keyCode', () => {
  it('names the key a replayed letter, digit, or mark comes from', () => {
    expect(keyCode('d')).toBe('KeyD')
    expect(keyCode('D')).toBe('KeyD')
    expect(keyCode('2')).toBe('Digit2')
    expect(keyCode('.')).toBe('Period')
    expect(keyCode('é')).toBe('')
  })
})

describe('composingKey', () => {
  it('is a key of an input method composition: isComposing, keyCode 229 or key Process', () => {
    expect(composingKey({ isComposing: true, keyCode: 8, key: 'Backspace' })).toBe(true)
    expect(composingKey({ isComposing: false, keyCode: 229, key: 'Backspace' })).toBe(true)
    expect(composingKey({ isComposing: false, keyCode: 0, key: 'Process' })).toBe(true)
    expect(composingKey({ isComposing: false, keyCode: 8, key: 'Backspace' })).toBe(false)
    expect(composingKey({ isComposing: false, keyCode: 66, key: 'b' })).toBe(false)
  })
})
