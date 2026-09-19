import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * A deal and the sales document produced for it.
 *
 * Deliberately NOT an ORM relation in either direction: `deal_id` points into
 * `customers` and `document_id` into `sales`, and a cross-module relation would
 * couple this table to their schemas (`.ai/guides/contracts.md:10`).
 *
 * No unique index on `deal_id`. Whether a deal may carry more than one quote is
 * the calling command's policy, not the schema's, and the schema leaves both
 * options open.
 */
@Entity({ tableName: 'deal_document_links' })
@Index({
  name: 'deal_document_links_deal_idx',
  properties: ['tenantId', 'organizationId', 'dealId', 'deletedAt'],
})
export class DealDocumentLink {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'deal_id', type: 'uuid' })
  dealId!: string

  @Property({ name: 'document_id', type: 'uuid' })
  documentId!: string

  @Property({ name: 'document_kind', type: 'text' })
  documentKind!: 'quote' | 'order'

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
