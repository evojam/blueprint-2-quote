/**
 * Read-only: what the extraction worker actually SAW and PRODUCED for the most recent
 * inbox proposals — the cleaned e-mail text the LLM was given, and the decrypted payload
 * of every proposed action.
 *
 * Reach for this when an inbox action misbehaves and the payload is the suspect. It
 * answers the question a log line cannot: did the model fail to extract something, or
 * did it extract it under a key nothing reads? Those two look identical from the UI, and
 * guessing between them costs more than one run of this.
 *
 * `raw_text`, `cleaned_text` and `payload` are encrypted at rest
 * (`inbox_ops/encryption.ts`), so `psql` alone returns ciphertext. This boots the app
 * container and reads through the same decryption path the app uses, which is why it
 * needs `TENANT_DATA_ENCRYPTION_KEY` — `yarn remote-db` injects it.
 *
 *   yarn inspect-inbox-proposal [limit]                            # local database
 *   yarn remote-db --env <environment> -- yarn inspect-inbox-proposal [limit]
 *
 * Prints decrypted tenant PII (names, addresses, message bodies). Read it in the
 * terminal; do not redirect it into the repo or paste it into a ticket.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import { bootstrap } from '@/bootstrap'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  InboxEmail,
  InboxProposal,
  InboxProposalAction,
} from '@open-mercato/core/modules/inbox_ops/data/entities'

const limit = Number(process.argv[2] ?? 3)

function preview(value: unknown, max = 2500): string {
  if (value == null) return '(null)'
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more chars]` : text
}

async function main(): Promise<void> {
  // `createRequestContainer` throws "DI registrars not registered" without this; the
  // app runtimes and `yarn mercato` both bootstrap before they resolve anything.
  bootstrap()
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const proposals = await em.find(
    InboxProposal,
    { deletedAt: null },
    { orderBy: { createdAt: 'DESC' }, limit },
  )
  if (proposals.length === 0) {
    console.log('No proposals found.')
    return
  }

  for (const proposal of proposals) {
    const scope = { tenantId: proposal.tenantId, organizationId: proposal.organizationId }
    const [decrypted] = await findWithDecryption(em, InboxProposal, { id: proposal.id }, undefined, scope)
    const [email] = await findWithDecryption(
      em,
      InboxEmail,
      { id: proposal.inboxEmailId },
      undefined,
      scope,
    )
    const actions = await findWithDecryption(
      em,
      InboxProposalAction,
      { proposalId: proposal.id },
      { orderBy: { sortOrder: 'ASC' } },
      scope,
    )

    console.log('\n' + '='.repeat(78))
    console.log(`proposal ${proposal.id}  created ${proposal.createdAt?.toISOString?.() ?? '?'}  status ${proposal.status}`)
    console.log(`model ${decrypted?.llmModel ?? '?'}  lang ${proposal.detectedLanguage ?? '?'}`)
    console.log(`summary: ${preview(decrypted?.summary, 400)}`)
    console.log(`participants: ${preview(decrypted?.participants, 600)}`)

    if (email) {
      console.log('\n--- e-mail as stored ---')
      console.log(`from: ${preview(email.forwardedByAddress, 200)}  name: ${preview(email.forwardedByName, 200)}`)
      console.log(`subject: ${preview(email.subject, 300)}`)
      console.log(`attachments: ${preview(email.attachmentIds, 300)}`)
      console.log(`--- cleaned_text (what the LLM was given) ---\n${preview(email.cleanedText)}`)
      console.log(`--- raw_text ---\n${preview(email.rawText, 1200)}`)
    } else {
      console.log('\n(no e-mail row found for this proposal)')
    }

    console.log('\n--- proposed actions ---')
    for (const action of actions) {
      console.log(`\n[${action.sortOrder}] ${action.actionType}  status=${action.status}  conf=${action.confidence}`)
      if (action.executionError) console.log(`  error: ${preview(action.executionError, 400)}`)
      console.log(`  payload: ${preview(action.payload, 1500)}`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
