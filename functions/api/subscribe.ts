interface Env {
  RESEND_API_KEY?: string;
  RESEND_SEGMENT_ID?: string;
}

interface PagesFunctionContext {
  request: Request;
  env: Env;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

export async function onRequestPost(context: PagesFunctionContext) {
  if (!context.env.RESEND_API_KEY) {
    return jsonResponse({ error: "Email capture is not configured." }, { status: 503 });
  }

  let payload: { email?: unknown; source?: unknown };
  try {
    payload = await context.request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, { status: 400 });
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!emailPattern.test(email)) {
    return jsonResponse({ error: "Enter a valid email address." }, { status: 400 });
  }

  const segments = context.env.RESEND_SEGMENT_ID ? [{ id: context.env.RESEND_SEGMENT_ID }] : undefined;
  const contactResponse = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${context.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      unsubscribed: false,
      ...(segments ? { segments } : {}),
    }),
  });

  if (!contactResponse.ok && contactResponse.status !== 409) {
    return jsonResponse({ error: "Unable to subscribe." }, { status: 502 });
  }

  if (!context.env.RESEND_SEGMENT_ID || contactResponse.ok) {
    return jsonResponse({ ok: true });
  }

  const segmentResponse = await fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${context.env.RESEND_SEGMENT_ID}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${context.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
  });

  if (segmentResponse.ok || segmentResponse.status === 409) {
    return jsonResponse({ ok: true });
  }

  let segmentDetails: unknown = null;
  try {
    segmentDetails = await segmentResponse.json();
  } catch {
    segmentDetails = await segmentResponse.text();
  }

  return jsonResponse({ error: "Unable to add contact to segment.", details: segmentDetails }, { status: 502 });
}
