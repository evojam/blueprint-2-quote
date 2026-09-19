/**
 * The document picker on the create form offers quotes and orders in ONE
 * combobox, so a single field value has to carry both the kind and the id.
 *
 * Why one field rather than a "kind" select driving a "document" select:
 * `CrudForm`'s `loadOptions(query)` receives only the typed query and never the
 * form's other values (`@open-mercato/ui/backend/CrudForm.tsx:241`), so a
 * dependent picker would need a hand-rolled custom field. Encoding the kind into
 * the value keeps the pair consistent by construction — it is impossible to
 * submit `documentKind: 'order'` with a quote's id.
 */
export type DocumentKind = 'quote' | 'order'

export type DocumentRef = {
  documentKind: DocumentKind
  documentId: string
}

const DOCUMENT_KINDS: readonly DocumentKind[] = ['quote', 'order']

/**
 * Deliberately looser than `@open-mercato/shared/lib/crud/ids.ts`, which also
 * pins the UUID version and variant nibbles. The server's `z.string().uuid()` on
 * `documentLinkCreateSchema` is the authority on what is acceptable; a stricter
 * client-side regex could reject an id the API would have taken, which is the
 * worse failure of the two.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isDocumentKind(raw: unknown): raw is DocumentKind {
  return typeof raw === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(raw)
}

/**
 * Shape check only, deliberately reusing `UUID_RE` above rather than a second
 * regex: both the document-side and deal-side pickers need "does this look
 * like a UUID" without pinning the version/variant nibbles the server's
 * `z.string().uuid()` doesn't either. The server remains the authority on
 * what is actually acceptable.
 */
export function isLikelyUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

export function encodeDocumentRef(ref: DocumentRef): string {
  return `${ref.documentKind}:${ref.documentId}`
}

export function decodeDocumentRef(raw: unknown): DocumentRef | null {
  if (typeof raw !== 'string') return null
  const separator = raw.indexOf(':')
  if (separator < 0) return null
  const kind = raw.slice(0, separator)
  const id = raw.slice(separator + 1)
  if (!isDocumentKind(kind)) return null
  if (!UUID_RE.test(id)) return null
  return { documentKind: kind, documentId: id }
}
