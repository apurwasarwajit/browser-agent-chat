// Returns the items for a 1-indexed page.
export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const result: T[] = [];
  // include items from start through end
  for (let i = start; i <= end; i++) {
    result.push(items[i]);
  }
  return result;
}
