import { WORDMARK_EMAIL_PNG_BASE64 } from "./brandAssets";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Only a canonical server-generated invitation URL belongs in either MIME part. */
function exactInviteUrl(link: string, origin: string): string {
  try {
    const base = new URL(origin), url = new URL(link);
    const local = base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
    if ((!local && base.protocol !== "https:") || base.origin !== origin || base.username || base.password || url.origin !== origin || url.username || url.password || url.search || url.hash || !/^\/invite\/pbi_[A-Za-z0-9_-]{43}$/.test(url.pathname) || link !== `${origin}${url.pathname}`) throw Error();
    return link;
  } catch { throw new Error("Invalid invitation destination."); }
}

/** Generic copy deliberately accepts no board title, content, sender name or other metadata. */
export function renderInviteEmail(role: "viewer" | "editor", link: string, origin: string) {
  if (role !== "viewer" && role !== "editor") throw new Error("Invalid invitation role.");
  const destination = exactInviteUrl(link, origin);
  const label = role === "viewer" ? "Viewer" : "Editor";
  const permissions = role === "viewer"
    ? "Read the board’s cards, specs, plans and history."
    : "Read and change cards, specs and plans, and mark work complete.";
  const introduction = role === "viewer" ? "You've been invited to view a Planban board." : "You've been invited to edit a Planban board.";
  const text = `You're invited to a board on Planban\n\nYou've been invited as ${role === "viewer" ? "a viewer" : "an editor"}.\n${label} access: ${permissions}\n\nView your invitation (valid for 7 days):\n${destination}\n\nOpen the invitation, then sign in with your own account to join the board.\n\nIf you weren't expecting this invitation, you can ignore this email.`;
  const font = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>Planban invitation</title></head><body style="margin:0;padding:0;background:#f9f9f9;color:#0d0d0d;font-family:${font}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9"><tr><td align="center" style="padding:24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e9e9e9;border-radius:10px"><tr><td style="padding:21px 23px 17px;border-bottom:1px solid #e9e9e9"><img src="cid:planban-wordmark" width="132" height="32" alt="Planban" style="display:block;border:0;width:132px;height:32px;border-radius:5px"></td></tr><tr><td style="padding:28px;font-family:${font}"><p style="font-size:12px;color:#5d5d5d;margin:0 0 12px">BOARD INVITATION</p><h1 style="font-size:27px;line-height:1.2;letter-spacing:-.6px;font-weight:650;margin:0 0 16px">You're invited to a board</h1><p style="font-size:15px;line-height:1.65;color:#414141;margin:0 0 22px">${escape(introduction)}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;border:1px solid #e9e9e9;border-radius:6px;margin-bottom:24px"><tr><td style="padding:14px 16px;font-size:13px;line-height:1.6;font-family:${font}"><strong style="display:block;font-weight:600;margin-bottom:4px">${escape(label)} access</strong><span style="color:#5d5d5d">${escape(permissions)}</span></td></tr></table><table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#0d0d0d" style="background:#0d0d0d;border-radius:6px"><a href="${escape(destination)}" style="display:inline-block;padding:12px 20px;border:1px solid #0d0d0d;border-radius:6px;color:#fff;background:#0d0d0d;text-decoration:none;font-family:${font};font-size:14px;font-weight:600;line-height:1.2">View invitation</a></td></tr></table><p style="font-size:12px;line-height:1.6;color:#5d5d5d;margin:12px 0 24px">This invitation link expires in 7 days.</p><p style="font-size:13px;line-height:1.65;color:#414141;margin:0">Open the invitation, then sign in with your own account to join the board.</p></td></tr><tr><td style="padding:18px 28px;border-top:1px solid #e9e9e9;color:#5d5d5d;font-family:${font};font-size:11px;line-height:1.6">Sent by Planban<br>If you weren't expecting this invitation, you can ignore this email.</td></tr></table></td></tr></table></body></html>`;
  return { subject: "You're invited to a board on Planban", html, text,
    attachments: [{ filename: "planban-wordmark.png", content: WORDMARK_EMAIL_PNG_BASE64, content_type: "image/png", content_id: "planban-wordmark" }] };
}
