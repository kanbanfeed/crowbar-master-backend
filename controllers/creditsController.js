const { supabase } = require('../config/supabase');

async function ensureUser(email) {
  const { data, error } = await supabase
    .from('users')
    .upsert([{ email }], { onConflict: 'email' })
    .select()
    .single();
  if (error) console.error('ensureUser error:', error);
  return data;
}

// Helper function to update user total credits
async function bumpUserCredits(email, deltaCredits) {
  await ensureUser(email);
  const { data: curr, error: selErr } = await supabase
    .from('users')
    .select('total_credits')
    .eq('email', email)
    .single();
  if (selErr) console.error('select user total_credits error:', selErr);

  const newTotal = (curr?.total_credits || 0) + deltaCredits;
  const { error: updErr } = await supabase
    .from('users')
    .update({ total_credits: newTotal, updated_at: new Date().toISOString() })
    .eq('email', email);
  if (updErr) console.error('update user credits error:', updErr);
  return newTotal;
}

// Earn credits
const earnCredits = async (req, res) => {
  try {
    const { email, amount, origin } = req.body;
    if (!email || !amount || !origin) {
      return res.status(400).json({ error: 'Email, amount, and origin are required' });
    }

    const delta = parseInt(amount);
    const eligible_global_race = origin === 'access_pass';

    // Insert row-level record
    const { error: creditsErr } = await supabase
      .from('credits')
      .insert([{
        email, amount: delta, origin_site: origin,
        eligible_global_race, legal_accept: false
      }]);

    if (creditsErr) return res.status(400).json({ error: creditsErr.message });

    // Insert into ledger
    const { error: ledgerErr } = await supabase
      .from('credits_ledger')
      .insert([{
        email, delta, reason: 'api.earn', origin_site: origin
      }]);
    if (ledgerErr) console.error('ledger insert error:', ledgerErr);

    // Update total credits
    const newTotal = await bumpUserCredits(email, delta);

    res.json({
      success: true,
      email,
      delta,
      origin,
      balance: newTotal,
      message: `Credits added successfully for ${email}`
    });
  } catch (error) {
    console.error('earnCredits error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get balance
const getBalance = async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email parameter is required' });

    const { data, error } = await supabase
      .from('users')
      .select('total_credits')
      .eq('email', email)
      .maybeSingle();

    const balance = data?.total_credits ?? 0;
    if (error) console.error('getBalance error:', error);

    res.json({ success: true, email, balance });
  } catch (error) {
    console.error('getBalance catch:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Spend credits
const spendCredits = async (req, res) => {
  try {
    const { email, amount, origin } = req.body;
    if (!email || !amount) {
      return res.status(400).json({ error: 'Email and amount are required' });
    }
    const delta = -Math.abs(parseInt(amount));
    const origin_site = origin || 'spend';

    // Insert into credits table
    const { error: creditsErr } = await supabase
      .from('credits')
      .insert([{ email, amount: delta, origin_site, legal_accept: false }]);
    if (creditsErr) return res.status(400).json({ error: creditsErr.message });

    // Insert into ledger
    const { error: ledgerErr } = await supabase
      .from('credits_ledger')
      .insert([{ email, delta, reason: 'api.spend', origin_site }]);
    if (ledgerErr) console.error('ledger insert error:', ledgerErr);

    // Update total credits
    const newTotal = await bumpUserCredits(email, delta);

    res.json({
      success: true,
      email,
      delta: Math.abs(delta),
      origin: origin_site,
      balance: newTotal,
      message: `Successfully spent ${Math.abs(delta)} credits for ${email}`
    });
  } catch (error) {
    console.error('spendCredits error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};



// Function to handle applying the referral/promo code
async function applyReferralCode(req, res) {
  try {
    const { user_email, promo_code } = req.body || {};
    const email = (user_email || '').toLowerCase();
    const code = (promo_code || '').trim();

    if (!email || !email.includes('@')) {
      return res.status(400).json({ message: 'Valid user email is required' });
    }
    if (!code) {
      return res.status(400).json({ message: 'Referral code is required' });
    }

    // 1. Find referrer by referral_code
    const { data: referrer, error: refErr } = await supabase
      .from('users')
      .select('email, referral_code')
      .eq('referral_code', code)
      .single();

    if (refErr || !referrer) {
      return res.status(404).json({ message: 'Invalid referral code' });
    }

    // Cannot refer yourself
    if (referrer.email.toLowerCase() === email) {
      return res.status(400).json({ message: 'You cannot use your own referral code' });
    }

    // 2. Make sure this user has not already used a code
    const { data: existingReferral } = await supabase
      .from('referrals')
      .select('id')
      .eq('referred_email', email)
      .maybeSingle();

    if (existingReferral) {
      return res.status(400).json({ message: 'Referral code already used for this account' });
    }

    // 3. Record referral relationship
    const { error: insertErr } = await supabase
      .from('referrals')
      .insert({
        referrer_email: referrer.email.toLowerCase(),
        referred_email: email,
        referral_code: code,
      });

    if (insertErr) {
      console.error('Insert referral error:', insertErr);
      return res.status(500).json({ message: 'Failed to record referral' });
    }

    // 4. Update referred user row
    await supabase
      .from('users')
      .update({ referred_by: referrer.email.toLowerCase() })
      .eq('email', email);

    // 5. Award +25 credits to referrer
    await earnCredits(referrer.email.toLowerCase(), 25, 'referral_signup');

    return res.json({
      success: true,
      message: 'Referral code applied. Referrer has received +25 credits.',
    });
  } catch (err) {
    console.error('applyReferralCode error:', err);
    return res.status(500).json({ message: 'Server error applying referral code' });
  }
}



module.exports = { earnCredits, getBalance, spendCredits, applyReferralCode };
