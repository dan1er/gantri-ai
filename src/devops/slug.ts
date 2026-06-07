export function slugFromRef(ref: string): string {
  const ticket = ref.match(/as-\d+/i);
  if (ticket) return ticket[0].toLowerCase();
  const tail = ref
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return tail || 'preview';
}

export function backendUrl(slug: string): string {
  return `https://${slug}.api.preview.gantri.com`;
}
