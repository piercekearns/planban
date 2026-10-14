// Writes the web page's _headers file into the built page, from the deployed
// Clerk and Convex addresses. Run after `npm run build`, before deploying the
// Worker (online/README.md, "Deploying the web page"):
//
//   ~/mac-mini-setup/dev24 node --import tsx/esm online/edge/write-headers.ts \
//     --clerk https://clerk.example --convex https://name-123.eu-west-1.convex.cloud
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { headersFile } from "./webHeaders";

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const clerk = value("clerk");
const convex = value("convex");
if (!clerk || !convex) {
  process.stderr.write("Usage: write-headers.ts --clerk <Clerk frontend API origin> --convex <Convex cloud address> [--out <file>]\n");
  process.exit(2);
}
const out = value("out") ?? fileURLToPath(new URL("../../dist/web/_headers", import.meta.url));
await writeFile(out, headersFile({ clerkFrontendApi: clerk, convexCloudUrl: convex }));
process.stdout.write(`Wrote ${out}\n`);
