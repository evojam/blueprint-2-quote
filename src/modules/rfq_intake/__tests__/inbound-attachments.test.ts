import { describe, expect, it } from '@jest/globals'
import { normalizeMessageId } from '../lib/inboundAttachments'

describe('normalizeMessageId', () => {
  // The exact value Resend returned for the demo RFQ, and the value the inbound route
  // stores from it (`inbox_ops/api/webhook/inbound.ts:138` takes `data.message_id`
  // verbatim). They agree today — this pins that a future trimmed bracket on either
  // side still matches, because the failure would be silent: no attachments, no
  // analysis, no error.
  it('matches the same id with and without angle brackets', () => {
    const fromResend = '<60D52309-EFBF-470C-91A2-14948A14F3EB@evojam.com>'
    const bare = '60D52309-EFBF-470C-91A2-14948A14F3EB@evojam.com'

    expect(normalizeMessageId(fromResend)).toBe(normalizeMessageId(bare))
    expect(normalizeMessageId(fromResend)).toBe(bare)
  })

  it('tolerates surrounding whitespace', () => {
    expect(normalizeMessageId('  <a@b>  ')).toBe('a@b')
  })

  it('treats empty and missing ids as no id at all', () => {
    expect(normalizeMessageId(null)).toBeNull()
    expect(normalizeMessageId(undefined)).toBeNull()
    expect(normalizeMessageId('   ')).toBeNull()
    expect(normalizeMessageId('<>')).toBeNull()
  })
})
