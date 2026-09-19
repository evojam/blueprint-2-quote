import { Migration } from '@mikro-orm/migrations';

export class Migration20260919145535_deal_links extends Migration {

  override name = 'Migration20260919145535';

  override up(): void | Promise<void> {
    this.addSql(`create table "deal_document_links" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid null, "organization_id" uuid null, "deal_id" uuid not null, "document_id" uuid not null, "document_kind" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "deal_document_links_deal_idx" on "deal_document_links" ("tenant_id", "organization_id", "deal_id", "deleted_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "deal_document_links" cascade;`);
  }

}
