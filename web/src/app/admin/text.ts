/**
 * A server value as a pill label: "past_due" reads "Past due".
 *
 * Pills are written in sentence case (the kit no longer title-cases them), so raw
 * status and role values go through this rather than straight into the template.
 */
export function sentenceCase(value: string | null | undefined): string {
  const text = (value ?? '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}
