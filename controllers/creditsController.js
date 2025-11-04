const { supabase } = require('../config/supabase');

// Helper function to ensure user exists
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
      .single();

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
const applyReferralCode = async (req, res) => {
  const { user_email, promo_code } = req.body;

  // Validate that both email and promo code are provided
  if (!user_email || !promo_code) {
    return res.status(400).json({ message: 'Email and promo code are required.' });
  }

  try {
    // Check if the promo code exists and is unused
    const { data: promoCodeData, error } = await supabase
      .from('promo_referral_codes')
      .select('*')
      .eq('code', promo_code)
      .eq('status', 'unused')
      .single();

    if (error || !promoCodeData) {
      return res.status(400).json({ message: 'Invalid or expired promo code.' });
    }

    // Extract the credits awarded by this promo code
    const creditsAwarded = promoCodeData.credits_awarded;

    // Get the current total credits of the user
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('total_spent, total_credits')
      .eq('email', user_email)
      .single();

    if (userError || !userData) {
      return res.status(400).json({ message: 'User not found.' });
    }

    // Add the promo credits to the user's current balance
    const updatedTotalCredits = userData.total_credits + creditsAwarded;

    // Update the user's credits and mark the promo code as used
    const { error: userUpdateError } = await supabase
      .from('users')
      .update({ total_credits: updatedTotalCredits })
      .eq('email', user_email);

    if (userUpdateError) {
      return res.status(400).json({ message: 'Error updating user credits.' });
    }

    await supabase
      .from('promo_referral_codes')
      .update({ status: 'used' }) // Mark promo code as used
      .eq('code', promo_code);

    // Insert the promo credit into the credits_ledger
    const { error: ledgerErr } = await supabase.from('credits_ledger').insert([{
      email: user_email,
      delta: creditsAwarded,
      reason: 'promo_code_used',
      origin_site: 'checkout',
      stripe_event_id: null,
      stripe_session_id: null,
      amount_usd: 0,
      created_at: new Date().toISOString(),
    }]);

    if (ledgerErr) {
      return res.status(400).json({ message: 'Error inserting ledger entry.' });
    }

    return res.status(200).json({ message: 'Promo code applied successfully.' });

  } catch (err) {
    console.error('Error applying promo code:', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};



module.exports = { earnCredits, getBalance, spendCredits, applyReferralCode };
