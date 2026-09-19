/**
 * `created_at` renders as `dd/mm/yyyy` (matches both injection widgets — the
 * brief's example: "Quote · 19/09/2026"). Not locale-aware — matches the rest
 * of this hackathon module.
 */
export function formatCreatedAt(raw?: string | null): string {
  if (!raw) return '—'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return '—'
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${date.getFullYear()}`
}
