// Converts a title into a URL-safe slug.
// Collapses whitespace, strips non-alphanumeric characters, and lowercases.
export function slugify(title: string): string {
  if (typeof title !== 'string') {
    throw new TypeError('slugify expects a string');
  }
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
