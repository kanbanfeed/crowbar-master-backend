const axios = require("axios");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function emailLayout(title, bodyHtml) {
  return `
  <div style="margin:0;padding:0;background:#f6f7fb;">
    <div style="max-width:640px;margin:0 auto;padding:28px 16px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
        <div style="padding:22px 24px;background:linear-gradient(135deg,#065f46,#059669);">
          <div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:13px;opacity:.95;">Crowbar</div>
          <h1 style="margin:10px 0 0 0;font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;">
            ${escapeHtml(title)}
          </h1>
        </div>
        <div style="padding:22px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
          ${bodyHtml}
          <p style="margin:18px 0 0 0;color:#9CA3AF;font-size:12px;">— Crowbar Team</p>
        </div>
      </div>
    </div>
  </div>`;
}

function buildCreditUpdateEmail({
  userName = "[User Name]",
  reason = "credits updated",
  delta = 0,
  newBalance = 0,
  amountUsd = null,
  originSite = null,
  occurredAt = new Date().toISOString(),
  supportEmail = process.env.SUPPORT_EMAIL || "support@crowbar.com",
}) {
  const r = String(reason || "").toLowerCase();
  const reasonLabel =
    r.includes("refund") ? "Refund Processed" :
    r.includes("membership_purchase") || r.includes("payment") ? "Payment Successful" :
    r.includes("gain") ? "Credits Added" :
    "Credits Updated";

  const subject = `Crowbar Credit Update: ${reasonLabel}`;
  const deltaText = Number(delta) > 0 ? `+${delta}` : String(delta);

  const body = `
    <p style="margin:0 0 12px 0;font-size:14px;line-height:1.75;color:#111827;">
      Dear ${escapeHtml(userName)},
    </p>

    <p style="margin:0 0 12px 0;font-size:14px;line-height:1.75;color:#374151;">
      Your Crowbar credits have been updated.
    </p>

    <ul style="margin:0 0 14px 18px;padding:0;color:#374151;font-size:14px;line-height:1.75;">
      <li><strong>Activity:</strong> ${escapeHtml(reasonLabel)}</li>
      <li><strong>Credits Change:</strong> ${escapeHtml(deltaText)}</li>
      <li><strong>Current Balance:</strong> ${escapeHtml(String(newBalance))}</li>
      <li><strong>Date:</strong> ${escapeHtml(String(occurredAt))}</li>
      ${amountUsd != null ? `<li><strong>Amount (USD):</strong> ${escapeHtml(String(amountUsd))}</li>` : ""}
      ${originSite ? `<li><strong>Origin Site:</strong> ${escapeHtml(String(originSite))}</li>` : ""}
    </ul>

    <p style="margin:0;font-size:14px;line-height:1.75;color:#374151;">
      If you have questions, contact us at
      <a style="color:#059669;text-decoration:underline;" href="mailto:${supportEmail}">${supportEmail}</a>.
    </p>
  `;

  return { subject, html: emailLayout(subject, body) };
}

async function sendBrevoEmail({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("Missing BREVO_API_KEY");

  const senderEmail = process.env.BREVO_SENDER_EMAIL || "mail@crowbarltd.com";
  const senderName = process.env.BREVO_SENDER_NAME || "Crowbar";

  const resp = await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    },
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 15000,
    }
  );

  return resp.data; // contains messageId typically
}

module.exports = { buildCreditUpdateEmail, sendBrevoEmail };
