# Upgrade Notes

## property_documents.catalog_matcher

`property_documents.catalog_matcher` remains the stable matcher ID. No database migration is required.

Deprecated legacy call: `{ text, limit? }` returns the flat `{ matches, unmatchedTerms }` research envelope.

New grouped call: `{ mode: 'grouped', text, maxNeeds, limitPerNeed }` returns `{ data: { contractVersion: 2, needs, warnings } }` in the research envelope.

The legacy form remains supported through the next minor release. Migrate callers to grouped mode before that compatibility window ends.
