import assert from "node:assert/strict";
import test from "node:test";
import { auditReleasePolicy, expectedLinuxRunner } from "../scripts/release-policy.mjs";

const workflows = {
  ".github/workflows/ci.yml": "jobs:\n  release-preflight:\n    runs-on: ubuntu-24.04\n",
  ".github/workflows/release-readiness.yml": [
    "jobs:",
    "  exact-sha-preflight:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - run: npm install --global @openai/codex@0.150.1",
    "      - run: npm run release:upgrade-rehearsal -- --from-version \"$FROM_VERSION\" --expected-version \"$EXPECTED_VERSION\"",
    "      - run: npm install --global @anthropic-ai/claude-code@2.1.296",
    "      - run: npm run release:claude-upgrade-rehearsal -- --from-version \"$FROM_VERSION\" --expected-version \"$EXPECTED_VERSION\"",
    "",
  ].join("\n"),
};

test("selects Blacksmith only for pjk-hq GitHub remotes", () => {
  assert.equal(expectedLinuxRunner("git@github.com:pjk-hq/planban.git"), "blacksmith-2vcpu-ubuntu-2404");
  assert.equal(expectedLinuxRunner("https://github.com/piercekearns/planban.git"), "ubuntu-24.04");
});

test("rejects release workflows that use the wrong Linux runner for their remote owner", () => {
  assert.deepEqual(auditReleasePolicy({
    remoteUrl: "https://github.com/piercekearns/planban.git",
    workflows: {
      ...workflows,
      ".github/workflows/ci.yml": workflows[".github/workflows/ci.yml"].replace("ubuntu-24.04", "blacksmith-2vcpu-ubuntu-2404"),
    },
    packageJson: { allowScripts: {} },
    packageLock: { packages: {} },
  }), [".github/workflows/ci.yml must use runs-on: ubuntu-24.04 for GitHub remote owner piercekearns"]);
});

test("rejects dependency install scripts unless their exact locked versions were reviewed", () => {
  assert.deepEqual(auditReleasePolicy({
    remoteUrl: "https://github.com/piercekearns/planban.git",
    workflows,
    packageJson: { allowScripts: { "esbuild@0.28.0": true } },
    packageLock: {
      packages: {
        "node_modules/esbuild": { version: "0.28.1", hasInstallScript: true },
      },
    },
  }), [
    "unreviewed dependency install scripts: esbuild@0.28.1",
    "stale dependency install-script allowlist entries: esbuild@0.28.0",
  ]);
});

test("requires release readiness to rehearse Codex and Claude Code upgrades with pinned CLIs", () => {
  const readiness = workflows[".github/workflows/release-readiness.yml"];
  const audit = (source: string) => auditReleasePolicy({
    remoteUrl: "https://github.com/piercekearns/planban.git",
    workflows: { ...workflows, ".github/workflows/release-readiness.yml": source },
    packageJson: { allowScripts: {} },
    packageLock: { packages: {} },
  });

  assert.deepEqual(audit(readiness), []);
  assert.deepEqual(audit(readiness.replace("@anthropic-ai/claude-code@2.1.296", "@anthropic-ai/claude-code@latest")), [
    ".github/workflows/release-readiness.yml must install a pinned Claude Code CLI version",
  ]);
  assert.deepEqual(audit(readiness.replace(/^.*release:claude-upgrade-rehearsal.*$/mu, "")), [
    ".github/workflows/release-readiness.yml must run the Claude Code upgrade rehearsal (npm run release:claude-upgrade-rehearsal)",
  ]);
  assert.deepEqual(audit(readiness.replace(/^.*@openai\/codex.*$/mu, "")), [
    ".github/workflows/release-readiness.yml must install a pinned Codex CLI version",
  ]);
});
