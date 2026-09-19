import { describe, expect, it } from '@jest/globals'
import {
  decodeDocumentRef,
  encodeDocumentRef,
  isDocumentKind,
  type DocumentRef,
} from '../lib/document-ref'

const QUOTE_ID = '11111111-2222-4333-8444-555555555555'

describe('document reference codec', () => {
  it('round trips a quote reference', () => {
    const ref: DocumentRef = { documentKind: 'quote', documentId: QUOTE_ID }
    expect(decodeDocumentRef(encodeDocumentRef(ref))).toEqual(ref)
  })

  it('round trips an order reference', () => {
    const ref: DocumentRef = { documentKind: 'order', documentId: QUOTE_ID }
    expect(decodeDocumentRef(encodeDocumentRef(ref))).toEqual(ref)
  })

  it('encodes as kind:id so the value is readable in the DOM', () => {
    expect(encodeDocumentRef({ documentKind: 'quote', documentId: QUOTE_ID }))
      .toBe(`quote:${QUOTE_ID}`)
  })

  // The form field is a free-standing combobox; whatever ends up in it is
  // untrusted until decoded.
  it.each([
    ['an unknown kind', `invoice:${QUOTE_ID}`],
    ['a missing kind', QUOTE_ID],
    ['a malformed id', 'quote:not-a-uuid'],
    ['an empty string', ''],
    ['a separator only', ':'],
  ])('rejects %s', (_label, raw) => {
    expect(decodeDocumentRef(raw)).toBeNull()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['an object', { documentKind: 'quote' }],
  ])('rejects %s without throwing', (_label, raw) => {
    expect(decodeDocumentRef(raw)).toBeNull()
  })

  it('recognises only the two kinds the entity stores', () => {
    expect(isDocumentKind('quote')).toBe(true)
    expect(isDocumentKind('order')).toBe(true)
    expect(isDocumentKind('invoice')).toBe(false)
    expect(isDocumentKind(null)).toBe(false)
  })
})
