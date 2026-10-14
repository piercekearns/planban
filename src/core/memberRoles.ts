/** Omitted roles keep the documented default; malformed supplied roles fail. */
export function requestedMemberRole(value: unknown, omittedDefault?: "viewer" | "editor") {
  if (value === undefined) return omittedDefault ?? null;
  return value === "viewer" || value === "editor" ? value : null;
}
