import assert from "node:assert/strict";
import test from "node:test";
import { retargetMarketplace } from "../scripts/marketplace-rehearsal-config.mjs";

const upstream = "https://github.com/piercekearns/planban.git";
const fork = "https://github.com/contributor/planban.git";
const config = `[marketplaces.other]\nsource = "untouched"\nref = "main"\n\n[marketplaces.planban]\nsource_type = "git"\nsource = "${upstream}"\nref = "v1.1.4"\n\n[other]\nref = "unchanged"\n`;

test("switches both repository and branch for a fork candidate without altering other config", () => {
  assert.equal(retargetMarketplace(config, fork, "fix/bootstrap"), config.replace(upstream, fork).replace('ref = "v1.1.4"', 'ref = "fix/bootstrap"'));
});

test("supports repeated candidate-to-candidate rehearsals and rejects missing configuration", () => {
  assert.equal(retargetMarketplace(config, upstream, "v1.1.4"), config);
  assert.throws(() => retargetMarketplace("", fork, "fix"), /marketplace is missing/u);
  assert.throws(() => retargetMarketplace(config.replace('source = "'+upstream+'"', ""), fork, "fix"), /source is missing/u);
});
