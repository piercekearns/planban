import assert from "node:assert/strict";
import { test } from "node:test";
import { activeSessionIdentity, verifyHumanSession } from "../online/service/convex/model/humanSession";

test("human identity requires the configured issuer/party, session-only verification and an active matching provider session", async () => {
  const oldIssuer = process.env.CLERK_ISSUER, oldOrigin = process.env.PLANBAN_PUBLIC_URL;
  const expected = { userId: "user_fixture", sessionId: "sess_fixture" };
  const request = new Request("https://planban.example/oauth/identity", { headers: { Authorization: "Bearer synthetic.session.proof", Origin: "https://hostile.example" } });
  let claims: any, stateAuthenticated = true, session: any, options: any, sessionReads = 0, authenticatedRequest: Request;
  const client: any = {
    authenticateRequest: async (request: Request, settings: any) => { authenticatedRequest = request; options = settings; return { isAuthenticated: stateAuthenticated, toAuth: () => claims }; },
    sessions: { getSession: async () => { sessionReads++; return session; } },
  };
  const reset = () => {
    claims = { tokenType: "session_token", ...expected, sessionClaims: { iss: "https://dedicated.clerk.example", azp: "https://planban.example" } };
    session = { id: expected.sessionId, userId: expected.userId, status: "active" };
    stateAuthenticated = true; sessionReads = 0;
  };
  try {
    process.env.CLERK_ISSUER = "https://dedicated.clerk.example";
    process.env.PLANBAN_PUBLIC_URL = "https://planban.example";
    reset();
    assert.deepEqual(await verifyHumanSession(request, client), expected);
    assert.deepEqual(options, { acceptsToken: "session_token", authorizedParties: ["https://planban.example"] }, "caller Origin never selects the verifier's trusted party");
    assert.equal(sessionReads, 1);
    for (const scheme of ["bearer ", "BEARER\t"]) {
      reset();
      const supplied = new Request(request.url, { method: "POST", body: "unchanged handler payload", headers: { Authorization: scheme + "synthetic.session.proof", Origin: "https://hostile.example" } });
      assert.deepEqual(await verifyHumanSession(supplied, client), expected);
      assert.equal(authenticatedRequest!.headers.get("Authorization"), "Bearer synthetic.session.proof");
      assert.equal(authenticatedRequest!.url, supplied.url);
      assert.equal(authenticatedRequest!.method, "POST");
      assert.equal(await supplied.text(), "unchanged handler payload");
    }
    for (const value of ["oauth_token", "api_key", "m2m_token", null]) {
      reset(); claims.tokenType = value;
      assert.equal(await verifyHumanSession(request, client), null);
      assert.equal(sessionReads, 0);
    }
    for (const field of ["userId", "sessionId"]) {
      reset(); claims[field] = null;
      assert.equal(await verifyHumanSession(request, client), null);
    }
    for (const field of ["iss", "azp"]) {
      reset(); claims.sessionClaims[field] = "https://other.example";
      assert.equal(await verifyHumanSession(request, client), null);
      assert.equal(sessionReads, 0);
    }
    for (const status of ["ended", "revoked", "expired", "abandoned"]) {
      reset(); session.status = status;
      assert.equal(await verifyHumanSession(request, client), null);
    }
    for (const field of ["id", "userId"]) {
      reset(); session[field] = "other";
      assert.equal(await verifyHumanSession(request, client), null);
    }
    reset(); stateAuthenticated = false;
    assert.equal(await verifyHumanSession(request, client), null);
    assert.equal(await verifyHumanSession(new Request("https://planban.example/oauth/identity"), client), null);
    assert.equal(await verifyHumanSession(request, null), null);
  } finally {
    if (oldIssuer === undefined) delete process.env.CLERK_ISSUER; else process.env.CLERK_ISSUER = oldIssuer;
    if (oldOrigin === undefined) delete process.env.PLANBAN_PUBLIC_URL; else process.env.PLANBAN_PUBLIC_URL = oldOrigin;
  }
});

test("redemption session checks deny inactive, wrong-user, malformed and unavailable identity proofs", async () => {
  const client: any = { sessions: { getSession: async () => ({ id: "sess_fixture", userId: "user_fixture", status: "active" }) } };
  assert.deepEqual(await activeSessionIdentity("sess_fixture", "user_fixture", client), { sessionId: "sess_fixture", userId: "user_fixture" });
  assert.equal(await activeSessionIdentity("sess_fixture", "user_other", client), null);
  assert.equal(await activeSessionIdentity("../../sessions", "user_fixture", client), null);
  assert.equal(await activeSessionIdentity("sess_fixture", "../users", client), null);
  client.sessions.getSession = async () => { throw new Error("Provider unavailable"); };
  assert.equal(await activeSessionIdentity("sess_fixture", "user_fixture", client), null);
  assert.equal(await activeSessionIdentity("sess_fixture", "user_fixture", null), null);
});
