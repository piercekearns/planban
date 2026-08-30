export interface HierarchyPromptItem {
  id: string;
  title: string;
  parentId?: string | null;
}

export function groupAncestryForPrompt(items: HierarchyPromptItem[], item: HierarchyPromptItem): string {
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  const titles: string[] = [];
  const seen = new Set([item.id]);
  let parentId = item.parentId;
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    titles.unshift(parent.title);
    parentId = parent.parentId;
  }
  return titles.join(" > ");
}
