// One-time setup of a local, account-free Convex backend for development:
// enables development sign-in and creates a live-update signing key. Values
// go straight into the local deployment's environment and are never printed.
//
//   cd online/service && CONVEX_AGENT_MODE=anonymous node scripts/setup-local.mjs
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";

const convex = (...args) => execFileSync("npx", ["convex", ...args], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const existing = convex("env", "list");
if (!/^PLANBAN_DEV_AUTH=/m.test(existing)) convex("env", "set", "PLANBAN_DEV_AUTH", "1");
if (!/^PLANBAN_LIVE_SIGNING_KEY=/m.test(existing)) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...privateKey.export({ format: "jwk" }), kid: randomUUID() };
  convex("env", "set", "PLANBAN_LIVE_SIGNING_KEY", JSON.stringify(jwk));
}
console.log("Local Online Board backend is set up for development sign-in and live updates.");
