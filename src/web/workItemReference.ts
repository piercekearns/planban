// The Copy Reference clipboard payload: a human-readable title followed by an exact, host-neutral
// Planban reference. `planban:<board>` names a Board; `planban:<board>/<item>` names an Item or Group.
// The reference is the identity; the quoted title is display context only.
export function planbanReference(repoId: string, itemId?: string): string {
  return itemId ? `planban:${repoId}/${itemId}` : `planban:${repoId}`;
}

export function buildWorkItemReference(repoId: string, item: { id: string; title: string }): string {
  return `\u201C${item.title}\u201D \u00B7 ${planbanReference(repoId, item.id)}`;
}
