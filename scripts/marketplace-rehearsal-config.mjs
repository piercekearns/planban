// This edits only the rehearsal's isolated marketplace, never the user's config.
export function retargetMarketplace(config, sourceUrl, targetRef) {
  const section = /(^\[marketplaces\.planban\][^\S\n]*\n)([\s\S]*?)(?=^\[|(?![\s\S]))/mu;
  const match = config.match(section);
  if (!match) throw new Error("Isolated Planban marketplace is missing");
  let body = match[2];
  for (const [key, value] of [["source", sourceUrl], ["ref", targetRef]]) {
    const line = new RegExp(`^${key}\\s*=\\s*"[^"\\n]*"[^\\S\\n]*$`, "mu");
    if (!line.test(body)) throw new Error(`Isolated marketplace ${key} is missing`);
    body = body.replace(line, () => `${key} = ${JSON.stringify(value)}`);
  }
  return config.replace(section, () => match[1] + body);
}
