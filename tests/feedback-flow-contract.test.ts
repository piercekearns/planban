import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const feedbackSkillPath = new URL("../plugins/planban/skills/planban-feedback/SKILL.md", import.meta.url);
const feedbackMetadataPath = new URL("../plugins/planban/skills/planban-feedback/agents/openai.yaml", import.meta.url);
const planbanSkillPath = new URL("../plugins/planban/skills/planban/SKILL.md", import.meta.url);
const webPath = new URL("../src/web/main.tsx", import.meta.url);
const agentIssueTemplatePath = new URL("../.github/ISSUE_TEMPLATE/agent_investigated_bug.yml", import.meta.url);

test("feedback entry points route agents through investigation before public action", async () => {
  const [feedbackSkill, feedbackMetadata, planbanSkill, web, agentIssueTemplate] = await Promise.all([
    readFile(feedbackSkillPath, "utf8"),
    readFile(feedbackMetadataPath, "utf8"),
    readFile(planbanSkillPath, "utf8"),
    readFile(webPath, "utf8"),
    readFile(agentIssueTemplatePath, "utf8"),
  ]);

  assert.match(feedbackMetadata, /allow_implicit_invocation:\s*true/u);
  assert.match(planbanSkill, /appears to be experiencing a Planban bug/u);
  assert.match(feedbackSkill, /Treat the current conversation/u);
  assert.match(feedbackSkill, /search open and closed issues, pull requests/u);
  assert.match(feedbackSkill, /Do not present an unexplained menu/u);
  assert.match(feedbackSkill, /Never publish board names, repo ids, local URLs/u);
  assert.match(web, /Treat this note and available conversation\/workspace context as my initial account/u);
  assert.match(web, /search existing issues, pull requests, releases, and current source/u);
  assert.match(agentIssueTemplate, /Missing information does not block the report/u);
});

test("feedback contracts never recommend a pull request without an implemented and verified local fix", async () => {
  const [feedbackSkill, web] = await Promise.all([
    readFile(feedbackSkillPath, "utf8"),
    readFile(webPath, "utf8"),
  ]);

  assert.match(feedbackSkill, /already:\n\n1\. investigated this specific bug/u);
  assert.match(feedbackSkill, /implemented a concrete code or documentation change/u);
  assert.match(feedbackSkill, /retested the original failing scenario successfully/u);
  assert.match(feedbackSkill, /Do not recommend that the user ask an agent to file/u);
  assert.match(feedbackSkill, /Do not silently expand feedback capture into implementation work/u);
  assert.match(web, /only if you can verify that my agent already implemented and validated/u);
});
