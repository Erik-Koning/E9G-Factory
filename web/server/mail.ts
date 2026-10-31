// Email: sign-in links and invitations, through Resend when RESEND_API_KEY is set. Without it, in development and
// tests (MAIL_LOG), the message goes to the server's console instead, where a test can read the link.
import { config } from "./config.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  link: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export async function sendMail({ to, subject, text, link }: Mail): Promise<void> {
  const { resendKey, mailFrom, mailLog } = config();
  if (resendKey) {
    const { Resend } = await import("resend");
    const html = `<div style="font:15px/1.5 system-ui,sans-serif;max-width:560px">${text
      .split("\n\n")
      .map((p) => `<p>${escapeHtml(p).replaceAll(escapeHtml(link), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`)}</p>`)
      .join("")}</div>`;
    const { error } = await new Resend(resendKey).emails.send({ from: mailFrom, to, subject, text, html });
    if (error) throw new Error(`Resend refused the email: ${error.message}`);
    return;
  }
  if (mailLog) {
    // One line a test can find: the address and the link.
    console.info(`[mail] to=${to} subject=${JSON.stringify(subject)} link=${link}`);
    return;
  }
  throw new Error("no email service: set RESEND_API_KEY (or MAIL_LOG=1 outside production)");
}
