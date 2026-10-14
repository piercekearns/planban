export function boardPath(repoId: string, path: string) {
  return `/api/boards/${encodeURIComponent(repoId)}${path}`;
}

/** Keep imported identities in a single URL segment, never URL structure. */
export function cardPath(repoId: string, cardId: string, path = "", version?: number) {
  // WHATWG URL parsing normalizes even percent-encoded standalone dots.
  if (cardId === "." || cardId === "..") throw new Error("This card has an unsafe id.");
  const history = version === undefined ? "" : `/history/${encodeURIComponent(String(version))}`;
  return boardPath(repoId, `${history}/cards/${encodeURIComponent(cardId)}${path}`);
}
