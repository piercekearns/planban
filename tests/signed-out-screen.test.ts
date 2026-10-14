import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignedOutScreen } from "../src/web/onlineBoard";

const render = (reason: "missing" | "expired") =>
  renderToStaticMarkup(createElement(SignedOutScreen, { signedOut: { url: "https://app.planban.example", reason }, onSignedIn: () => {} }));

test("a signed-out Online Board offers Sign in, with the command only as a hint", () => {
  const html = render("missing");
  assert.match(html, /You&#x27;re signed out of Planban on this computer\./);
  assert.match(html, /This board is online at app\.planban\.example\./);
  assert.match(html, /<button class="primary"[^>]*> Sign in<\/button>/);
  assert.match(html, /For agents and terminals: <code>planban online login https:\/\/app\.planban\.example<\/code>/);
  assert.doesNotMatch(html, /Try again/);
  assert.doesNotMatch(html, /expired or is missing/);
});

test("an ended sign-in says so, and offers the same Sign in", () => {
  const html = render("expired");
  assert.match(html, /Your Planban sign-in on this computer has ended\./);
  assert.match(html, /> Sign in<\/button>/);
});
