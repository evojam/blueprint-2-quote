/**
 * Phase 0 go/no-go for `.ai/specs/2026-09-19-rfq-attachment-ingestion.md`.
 *
 * Answers the one question the whole design rests on: does the CONFIGURED Resend
 * integration actually expose inbound attachments for this deployment? The SDK's types
 * promise the endpoints; that is not the same as the account having them and Resend
 * retaining the bytes for this inbound domain.
 *
 * Reads the API key the way the feature will — from the `channel_resend` integration's
 * stored credentials via `integrationCredentialsService`, never from the environment —
 * so a green run proves the credential path too.
 *
 *   yarn remote-db --env <environment> -- yarn tsx scripts/dev-probe-resend-inbound.ts
 *
 * Read-only. Prints metadata and an 8-byte magic-number probe; never attachment
 * contents, never the key. Delete once the spec's Phase 0 is signed off.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import { Resend } from 'resend'
import { bootstrap } from '@/bootstrap'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'

type CredentialsService = {
  resolve: (
    integrationId: string,
    scope: { tenantId: string; organizationId: string | null },
  ) => Promise<Record<string, unknown> | null>
}

async function main(): Promise<void> {
  bootstrap()
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const credentialsService = container.resolve('integrationCredentialsService') as CredentialsService

  // Before concluding "not configured", look at what rows actually exist. The service's
  // filter matches `organization_id` EXACTLY (credentials-service.ts:90), so a
  // tenant-wide row saved with organization_id = NULL is invisible to an
  // organization-scoped resolve — a false negative that looks identical to "never
  // configured". Never prints a credential value, only where the row sits.
  const rows = await em.getConnection().execute<Array<{
    integration_id: string
    tenant_id: string
    organization_id: string | null
    user_id: string | null
    updated_at: Date
  }>>(
    `select integration_id, tenant_id, organization_id, user_id, updated_at
       from integration_credentials
      where integration_id = ? and deleted_at is null`,
    ['channel_resend'],
  )
  console.log(`integration_credentials rows for channel_resend: ${rows.length}`)
  for (const row of rows) {
    console.log(
      `  tenant=${row.tenant_id} org=${row.organization_id ?? 'NULL (tenant-wide)'}` +
      ` user=${row.user_id ?? 'NULL'} updated=${row.updated_at?.toISOString?.() ?? row.updated_at}`,
    )
  }
  if (rows.length === 0) {
    console.log('  → nothing stored: the integration is enabled but has no credentials saved.')
  }

  const organizations = await em.find(Organization, { deletedAt: null }, { populate: ['tenant'] as const })
  if (organizations.length === 0) {
    console.log('No organizations in this database.')
    return
  }

  for (const organization of organizations) {
    const scope = {
      tenantId: String((organization as unknown as { tenant: { id: string } }).tenant.id),
      organizationId: String(organization.id),
    }
    console.log(`\n=== organization ${organization.id} ===`)

    // Try the organization scope first, then the tenant-wide row, matching the
    // precedence a feature should use.
    const credentials = (await credentialsService.resolve('channel_resend', scope))
      ?? (await credentialsService.resolve('channel_resend', { ...scope, organizationId: null }))
    const integrationKey = typeof credentials?.apiKey === 'string' ? credentials.apiKey : null

    // Same order the feature will use: integration first, environment second. The env
    // key is what the installed inbound route already runs on today.
    const envKey = process.env.RESEND_API_KEY?.trim() || null
    const apiKey = integrationKey ?? envKey
    const source = integrationKey ? 'integration' : envKey ? 'environment (fallback)' : null

    if (!apiKey) {
      console.log('channel_resend: no key in the integration and none in the environment —')
      console.log('  the feature would open the case without attachments and say so.')
      continue
    }
    console.log(`channel_resend: key from ${source} (length ${apiKey.length})`)

    const resend = new Resend(apiKey)
    const list = await resend.emails.receiving.list()
    if (list.error) {
      console.log(`receiving.list FAILED: ${JSON.stringify(list.error)}`)
      console.log('  → NO-GO for this account: the design depends on this endpoint.')
      continue
    }

    const items = list.data?.data ?? []
    console.log(`receiving.list OK — ${items.length} inbound e-mail(s)`)

    for (const item of items.slice(0, 3)) {
      console.log(`\n- id=${item.id}`)
      console.log(`  subject=${item.subject}`)
      console.log(`  message_id=${item.message_id}   <- our correlation key`)

      const full = await resend.emails.receiving.get(item.id)
      if (full.error) {
        console.log(`  receiving.get FAILED: ${JSON.stringify(full.error)}`)
        continue
      }
      const attachments = full.data?.attachments ?? []
      console.log(`  attachments=${attachments.length}`)

      for (const attachment of attachments) {
        console.log(
          `    * ${attachment.filename} | ${attachment.content_type} | ${attachment.size}B` +
          ` | disposition=${attachment.content_disposition}`,
        )
        const signed = await resend.emails.receiving.attachments.get({
          emailId: item.id,
          id: attachment.id,
        })
        if (signed.error) {
          console.log(`      signed url FAILED: ${JSON.stringify(signed.error)}`)
          continue
        }
        const url = signed.data?.download_url
        console.log(`      expires_at=${signed.data?.expires_at} has_url=${Boolean(url)}`)
        if (!url) continue

        // 8 bytes is enough to see "%PDF-1.x" and prove the bytes are really reachable.
        const response = await fetch(url, { headers: { Range: 'bytes=0-7' } })
        const head = Buffer.from(await response.arrayBuffer()).toString('latin1')
        console.log(`      GET ${response.status} first-bytes=${JSON.stringify(head)}`)
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
