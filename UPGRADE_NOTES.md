# Upgrade Notes

## property_documents.catalog_matcher

`property_documents.catalog_matcher` remains the stable matcher ID. No database migration is required.

Deprecated legacy call: `{ text, limit? }` returns the flat `{ matches, unmatchedTerms }` research envelope.

New grouped call: `{ mode: 'grouped', text, maxNeeds, limitPerNeed }` returns `{ data: { contractVersion: 2, needs, warnings } }` in the research envelope.

The legacy form remains supported through the next minor release. Migrate callers to grouped mode before that compatibility window ends.
# Room measurement agent v2

- **Bridge:** The v1 agent and tool IDs (`property_documents.room_dimensions` and `property_documents.extract_room_dimensions`) and their top-level `Room[]` result remain available for at least one minor release.
- **Consumer migration:** The v2 IDs (`property_documents.room_measurements` and `property_documents.extract_room_measurements`) return an object result. They are incompatible with v1 and require consumers to change their parser; there is no alias or output transform.
- **Cutover:** Switch `rfq_intake.plans.analyze` to v2 only after the v2 generated, runtime, and live gates pass.
- **Rollback:** Switch `rfq_intake.plans.analyze` back to v1. No schema or data migration is required.
- **Removal:** Remove v1 only after a later audit of repository and external consumers confirms that none still depend on it.
