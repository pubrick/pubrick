/**
 * Slugs must be url-safe ascii. NFKD + diacritic strip keeps "Cafés Peña" usable
 * ("cafes-pena"); fully non-Latin names (ru, zh, ...) clean down to empty, so fall
 * back to "org-<suffix>" rather than emitting a leading-hyphen slug like "-k2f9x".
 */
export function orgSlug(name: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const cleaned = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? `${cleaned}-${suffix}` : `org-${suffix}`;
}
