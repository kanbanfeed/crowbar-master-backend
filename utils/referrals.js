// utils/referrals.js
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `CWB-${code}`;
}

async function ensureReferralCodeForUser(supabase, email) {
  const normEmail = email.toLowerCase();

  // already has code?
  const { data: user, error } = await supabase
    .from('users')
    .select('referral_code')
    .eq('email', normEmail)
    .single();

  if (error) throw error;
  if (user?.referral_code) return user.referral_code;

  // generate until unique
  let code;
  while (true) {
    code = generateReferralCode();
    const { data: existing } = await supabase
      .from('users')
      .select('email')
      .eq('referral_code', code)
      .maybeSingle();
    if (!existing) break;
  }

  const { error: updateErr } = await supabase
    .from('users')
    .update({ referral_code: code })
    .eq('email', normEmail);

  if (updateErr) throw updateErr;
  return code;
}

module.exports = { generateReferralCode, ensureReferralCodeForUser };
