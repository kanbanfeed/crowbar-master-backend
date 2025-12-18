const { buildCreditUpdateEmail, sendBrevoEmail } = require("../utils/brevoMailer");
const { supabase } = require("../config/supabase");

async function sendCreditActivityEmail({
  email,
  userName,
  reason,
  delta,
  newBalance,
  amountUsd,
  originSite,
  occurredAt,
  ledgerId,
  stripeEventId,
  stripeSessionId,
}) {
  const { subject, html } = buildCreditUpdateEmail({
    userName,
    reason,
    delta,
    newBalance,
    amountUsd,
    originSite,
    occurredAt,
  });

  let messageId = null;
try {
  const resp = await sendBrevoEmail({ to: email, subject, html });
  messageId = resp?.messageId ?? null;
} catch (e) {
  console.error("Brevo send failed:", e?.message || e);
  // don't throw
}


  // Optional audit log (only if you created the table)
  try {
   await supabase.from("notification_email_log").insert({
  user_id: null,
  email,
  notification_type: reason || "credits_updated",
  provider: "brevo",
  provider_message_id: messageId,
  payload: { delta, newBalance, amountUsd, originSite, stripeEventId, stripeSessionId, ledgerId },
  status: "sent",
  created_at: new Date().toISOString(),
});
  } catch (e) {
    console.error("notification_email_log insert failed:", e?.message || e);
  }

  return messageId;
}

module.exports = { sendCreditActivityEmail };
