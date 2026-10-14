import assert from "node:assert/strict";
import { test } from "node:test";
import { renderInviteEmail } from "../online/service/convex/model/inviteEmail";
import { sendInviteEmail } from "../online/service/convex/http";

const origin = "https://planban.example", link = origin + "/invite/pbi_" + "a".repeat(43);

test("HTML and plaintext preserve exact invitation destination and role-aware generic copy without external assets", () => {
  for (const role of ["viewer", "editor"] as const) {
    const mail = renderInviteEmail(role, link, origin);
    assert.equal(mail.subject, "You're invited to a board on Planban");
    assert.ok(mail.html.includes(`href="${link}"`));
    assert.equal((mail.html.match(/href=/g) ?? []).length, 1);
    assert.ok(mail.text.includes(link));
    for (const content of [mail.html, mail.text]) {
      assert.match(content, /7 days/);
      assert.match(content, /sign in with your own account/);
      assert.match(content, role === "viewer" ? /Viewer access/ : /Editor access/);
      assert.ok(!content.includes("private board title"));
    }
    assert.match(mail.html, /View invitation/);
    assert.match(mail.html, /role="presentation"/);
    assert.match(mail.html, /alt="Planban"/);
    assert.match(mail.html, /<meta name="color-scheme" content="light only">/);
    assert.ok(!/<script|<iframe|<form|https?:.*(?:\.png|\.woff)/i.test(mail.html));
    const image = mail.attachments[0]!;
    // The real wordmark, transparent, at twice its 122x22 display size.
    assert.equal(image.content_id, "planban-wordmark");
    assert.equal(image.content_type, "image/png");
    const bytes = Buffer.from(image.content, "base64");
    assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    assert.equal(bytes.readUInt32BE(16), 245);
    assert.equal(bytes.readUInt32BE(20), 44);
    assert.equal(bytes[25], 6, "colour type 6: RGB with alpha, so no white box in dark mail apps");
    assert.ok(bytes.length < 10000);
  }
  const viewer = renderInviteEmail("viewer", link, origin);
  assert.ok(!viewer.text.includes("mark work complete"));
  assert.match(renderInviteEmail("editor", link, origin).text, /mark work complete/);
});

test("uncanonical, injected, foreign, non-invite and insecure destinations fail with no capability in errors", () => {
  for (const bad of ["javascript:alert(1)", link + '" onmouseover="bad', link + "#fragment", link + "?next=bad", link + "\n", link.replace("https://", "https://user:password@"), link.replace("planban.example", "attacker.example"), link.replace("/invite/", "/other/"), link.replace("/invite/", "/path/../invite/"), link.replace("pbi_", "%70bi_"), link.replace("https:", "http:"), origin + "/invite/not-a-token"] ) {
    assert.throws(() => renderInviteEmail("viewer", bad, origin), error => error instanceof Error && error.message === "Invalid invitation destination.");
  }
  assert.throws(() => renderInviteEmail("<script>bad</script>" as any, link, origin), /Invalid invitation role/);
  assert.throws(() => renderInviteEmail("viewer", link, origin + "/"), /Invalid invitation destination/);
  for (const local of ["http://127.0.0.1:3411", "http://localhost:3411", "http://[::1]:3411"]) assert.ok(renderInviteEmail("viewer", local + "/invite/pbi_" + "b".repeat(43), local).html);
});

test("mail transport stays opt-in, includes both parts and one CID image, and rejects unsafe input before a mocked request", async () => {
  const previous = { key: process.env.RESEND_API_KEY, from: process.env.PLANBAN_INVITE_FROM, origin: process.env.PLANBAN_PUBLIC_URL, fetch: globalThis.fetch };
  let requests = 0, captured: any;
  try {
    delete process.env.RESEND_API_KEY; delete process.env.PLANBAN_INVITE_FROM;
    process.env.PLANBAN_PUBLIC_URL = origin;
    globalThis.fetch = async (_url, init) => { requests++; captured = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); };
    assert.equal(await sendInviteEmail("fixture@example.invalid", "viewer", link), false);
    assert.equal(requests, 0);
    process.env.RESEND_API_KEY = "synthetic-mail-fixture-only"; process.env.PLANBAN_INVITE_FROM = "Planban <fixture@example.invalid>";
    assert.equal(await sendInviteEmail("fixture@example.invalid", "invalid", link), false);
    assert.equal(await sendInviteEmail("fixture@example.invalid", "viewer", "https://attacker.example"), false);
    assert.equal(requests, 0);
    assert.equal(await sendInviteEmail("fixture@example.invalid", "viewer", link), true);
    assert.equal(requests, 1);
    assert.ok(captured.html.includes(link) && captured.text.includes(link));
    assert.equal(captured.attachments.length, 1);
    assert.equal(captured.attachments[0].content_id, "planban-wordmark");
    assert.deepEqual(captured.to, ["fixture@example.invalid"]);
  } finally {
    for (const [name, value] of [["RESEND_API_KEY", previous.key], ["PLANBAN_INVITE_FROM", previous.from], ["PLANBAN_PUBLIC_URL", previous.origin]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    globalThis.fetch = previous.fetch;
  }
});
