// One email sender for the whole app (PLATFORM.md decision 7, D 2026-10-09). Provider by env:
//   MAILJET_API_KEY + MAILJET_SECRET_KEY (+ EMAIL_FROM) -> Mailjet Send API v3.1 (D, 2026-10-12: the agency's Mailjet account)
//   RESEND_API_KEY (+ EMAIL_FROM)  -> Resend HTTP API
//   SMTP_URL (+ EMAIL_FROM)        -> SMTP via nodemailer, loaded only if installed (npm i nodemailer)
//   neither                        -> logged to the console (dev); `sent` is false so callers can tell
export type EmailMessage = { to: string | string[]; subject: string; text: string; html?: string; from?: string; replyTo?: string };
export type EmailResult = { sent: boolean; provider: 'mailjet' | 'resend' | 'smtp' | 'console'; id?: string; error?: string };

export function emailProvider(env: NodeJS.ProcessEnv = process.env): EmailResult['provider'] {
  if (env.MAILJET_API_KEY && env.MAILJET_SECRET_KEY) return 'mailjet';
  if (env.RESEND_API_KEY) return 'resend';
  if (env.SMTP_URL) return 'smtp';
  return 'console';
}

const fromOf = (m: EmailMessage) => m.from || process.env.EMAIL_FROM || 'no-reply@localhost';
/** '"Name" <a@b.c>' or 'Name <a@b.c>' or 'a@b.c' -> Mailjet's { Email, Name }. Sign-in and reset links are never tracked (no rewritten links). */
function parseAddress(raw: string): { Email: string; Name?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  return m ? { Email: m[2].trim(), ...(m[1].trim() ? { Name: m[1].trim() } : {}) } : { Email: raw.trim() };
}

/** EMAIL_FROM's address under another display name: emails sent on behalf of an agency carry the agency's name (white label, D
 *  2026-10-10), never the product's. Quotes, angle brackets and line breaks are dropped from the name. */
export function fromWithName(name: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const clean = String(name ?? '').replace(/[\r\n"<>\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  if (!clean) return undefined;
  const raw = (env.EMAIL_FROM || 'no-reply@localhost').trim();
  const addr = /<([^>]+)>\s*$/.exec(raw)?.[1]?.trim() || raw;
  return `"${clean}" <${addr}>`;
}

export async function sendEmail(m: EmailMessage): Promise<EmailResult> {
  const to = Array.isArray(m.to) ? m.to : [m.to];
  const provider = emailProvider();
  try {
    if (provider === 'mailjet') {
      const from = parseAddress(fromOf(m)), reply = m.replyTo ? parseAddress(m.replyTo) : null;
      const auth = Buffer.from(`${process.env.MAILJET_API_KEY}:${process.env.MAILJET_SECRET_KEY}`).toString('base64');
      const r = await fetch('https://api.mailjet.com/v3.1/send', {
        method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Messages: [{ From: from, To: to.map((e) => parseAddress(e)), Subject: m.subject, TextPart: m.text, ...(m.html ? { HTMLPart: m.html } : {}),
          ...(reply ? { ReplyTo: reply } : {}), TrackOpens: 'disabled', TrackClicks: 'disabled' }] }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json().catch(() => ({}))) as { Messages?: { Status?: string; To?: { MessageID?: number }[]; Errors?: { ErrorMessage?: string }[] }[]; ErrorMessage?: string };
      const msg = body.Messages?.[0];
      if (!r.ok || msg?.Status !== 'success') return { sent: false, provider, error: `mailjet ${r.status}: ${msg?.Errors?.[0]?.ErrorMessage ?? body.ErrorMessage ?? 'error'}` };
      return { sent: true, provider, id: String(msg.To?.[0]?.MessageID ?? '') };
    }
    if (provider === 'resend') {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromOf(m), to, subject: m.subject, text: m.text, html: m.html, reply_to: m.replyTo }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!r.ok) return { sent: false, provider, error: `resend ${r.status}: ${body.message ?? 'error'}` };
      return { sent: true, provider, id: body.id };
    }
    if (provider === 'smtp') {
      // nodemailer is optional: a variable specifier keeps the bundler from requiring it at build time
      const modName = 'nodemailer';
      const nm = (await import(/* webpackIgnore: true */ modName).catch(() => null)) as
        | { createTransport: (url: string) => { sendMail: (o: Record<string, unknown>) => Promise<{ messageId?: string }> } }
        | null;
      if (!nm) return { sent: false, provider, error: 'SMTP_URL is set but nodemailer is not installed (npm i nodemailer)' };
      const info = await nm.createTransport(process.env.SMTP_URL as string).sendMail({ from: fromOf(m), to: to.join(', '), subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo });
      return { sent: true, provider, id: info.messageId };
    }
    console.log(`[email:console] to=${to.join(',')} subject=${JSON.stringify(m.subject)}\n${m.text}`);
    return { sent: false, provider };
  } catch (e) {
    return { sent: false, provider, error: String((e as Error)?.message ?? e) };
  }
}
