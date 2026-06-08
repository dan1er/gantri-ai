export function slugFromRef(ref: string): string {
  const ticket = ref.match(/as-\d+/i);
  if (ticket) return ticket[0].toLowerCase();
  const tail = ref
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-|-$/g, ''); // trim AFTER the slice so truncation can't leave a trailing '-' (DNS-1123)
  return tail || 'preview';
}

export function backendUrl(slug: string): string {
  return `https://${slug}.preview.api.gantri.com`;
}
