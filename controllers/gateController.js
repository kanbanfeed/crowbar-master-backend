const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('../config/supabase');

const PARTNER_MAP = {
  talentkonnect: 'https://talentkonnect-redesign.vercel.app',
  careduel: 'https://careduel-redesign.vercel.app',
  ecoworldbuy: 'https://ecoworldbuy-redesign.vercel.app',
};

const CREDIT_MAP = {
  access_pass: 49,
  talentkonnect: 7,
  careduel: 3,
  ecoworldbuy: 7,
};

async function ensureUser(email) {
  const { data, error } = await supabase
    .from('users')
    .upsert([{ email }], { onConflict: 'email' })
    .select()
    .single();
  if (error) console.error('ensureUser error:', error);
  return data;
}

async function bumpUserCredits(email, deltaCredits) {
  await ensureUser(email);

  const { data: curr, error: selErr } = await supabase
    .from('users')
    .select('total_credits')
    .eq('email', email)
    .single();
  if (selErr) console.error('select user total_credits error:', selErr);

  const newTotal = (curr?.total_credits || 0) + Number(deltaCredits || 0);
  const { error: updErr } = await supabase
    .from('users')
    .update({ total_credits: newTotal, updated_at: new Date().toISOString() })
    .eq('email', email);
  if (updErr) console.error('update user credits error:', updErr);

  return newTotal;
}

async function bumpUserSpend(email, deltaUsd) {
  await ensureUser(email);

  const { data: curr, error: selErr } = await supabase
    .from('users')
    .select('total_spent, full_access')
    .eq('email', email)
    .single();
  if (selErr) console.error('select user spend error:', selErr);

  const newSpent = Number(curr?.total_spent || 0) + Number(deltaUsd || 0);
  const full_access = newSpent >= 99;

  const { error: updErr } = await supabase
    .from('users')
    .update({
      total_spent: newSpent,
      full_access,
      updated_at: new Date().toISOString(),
    })
    .eq('email', email);
  if (updErr) console.error('update user spend error:', updErr);

  return { newSpent, full_access };
}

async function hasAccessPass(email) {
  // Has any credited Access Pass with legal_accept recorded
  const { data, error } = await supabase
    .from('credits')
    .select('id')
    .eq('email', email)
    .eq('origin_site', 'access_pass')
    .eq('legal_accept', true)
    .limit(1);
  if (error) {
    console.error('hasAccessPass error:', error);
    return false;
  }
  return (data || []).length > 0;
}

function startOfUtcDay(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function endOfUtcDay(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

async function partnerRewardAlreadyGivenToday(email, origin) {
  const { data, error } = await supabase
    .from('credits_ledger')
    .select('id, created_at')
    .eq('email', email)
    .eq('origin_site', origin)
    .eq('reason', 'action.rewarded')
    .gte('created_at', startOfUtcDay())
    .lte('created_at', endOfUtcDay())
    .limit(1);
  if (error) {
    console.error('reward check error:', error);
    return true; 
  }
  return (data || []).length > 0;
}

async function awardPartnerOncePerDay(email, origin) {
  const credits = CREDIT_MAP[origin] ?? 0;
  if (credits <= 0) return { awarded: false, credits: 0 };

  const already = await partnerRewardAlreadyGivenToday(email, origin);
  if (already) return { awarded: false, credits: 0 };

  // 1) legacy history
  await supabase.from('credits').insert([{
    email,
    amount: credits,
    origin_site: origin,
    eligible_global_race: false,
    legal_accept: true,
  }]);

  // 2) ledger
  await supabase.from('credits_ledger').insert([{
    email,
    delta: credits,
    reason: 'action.rewarded',
    origin_site: origin,
  }]);

  // 3) users
  await bumpUserCredits(email, credits);

  return { awarded: true, credits };
}

async function awardAccessPassIfNeededFromSession(session) {
  const email =
    session?.metadata?.user_email ||
    session?.customer_details?.email ||
    session?.customer_email;

  if (!email) return { awarded: false, reason: 'no_email' };

  // Check if this session already logged in ledger
  const { data: existing, error: existErr } = await supabase
    .from('credits_ledger')
    .select('id')
    .eq('stripe_session_id', session.id)
    .eq('reason', 'checkout.session.completed')
    .limit(1);
  if (existErr) console.error('ledger check error:', existErr);
  if ((existing || []).length > 0) {
    return { awarded: false, reason: 'session_already_logged' };
  }

  const credits = CREDIT_MAP['access_pass'] || 49;
  const usd = session.amount_total ? session.amount_total / 100 : null;
  const legal_accept = String(session?.metadata?.legal_accept || '').toLowerCase() === 'true';

  // 1) legacy row
  await supabase.from('credits').insert([{
    email,
    amount: credits,
    origin_site: 'access_pass',
    eligible_global_race: true,
    legal_accept: !!legal_accept,
  }]);

  // 2) ledger row
  await supabase.from('credits_ledger').insert([{
    email,
    delta: credits,
    reason: 'checkout.session.completed',
    origin_site: 'access_pass',
    stripe_session_id: session.id,
    amount_usd: usd,
  }]);

  // 3) users total/spend
  await bumpUserCredits(email, credits);
  if (usd) await bumpUserSpend(email, usd);

  return { awarded: true, reason: 'created' };
}

// ---------- Controllers ----------

/**
 * POST /api/gate/start
 * Body: { email, origin, return_to, legal_accept }
 * - If user has Access Pass → award partner (once/day) and return { redirect_url }
 * - Else → requires legal_accept=true, creates Stripe session and returns { checkout_url, sessionId }
 */
const startGate = async (req, res) => {
  try {
    const { email, origin, return_to, legal_accept } = req.body || {};

    if (!email || !origin) {
      return res.status(400).json({ success: false, error: 'email and origin are required' });
    }
    if (!PARTNER_MAP[origin]) {
      return res.status(400).json({ success: false, error: 'invalid origin' });
    }

    const hasPass = await hasAccessPass(email);

    if (hasPass) {
      await awardPartnerOncePerDay(email, origin);
      const redirect_url = PARTNER_MAP[origin];
      return res.json({ success: true, need_payment: false, redirect_url });
    }

    if (String(legal_accept).toLowerCase() !== 'true') {
      return res.status(400).json({ success: false, error: 'legal_accept is required' });
    }

    // Create Stripe Checkout Session for Access Pass
    const priceId = process.env.STRIPE_PRICE_ACCESS_PASS || 'price_1SNsAuQZJXcO4yAMKXAehmNP';
    const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontend}/payment-success?session_id={CHECKOUT_SESSION_ID}&origin=${encodeURIComponent(origin)}&return_to=${encodeURIComponent(return_to || origin)}`,
      cancel_url: `${frontend}/payment-cancel`,
      customer_email: email,
      metadata: {
        user_email: email,
        product_type: 'access_pass',
        legal_accept: 'true',
        origin,
        return_to: return_to || origin,
      },
    });

    return res.json({
      success: true,
      need_payment: true,
      checkout_url: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error('startGate error:', err);
    res.status(500).json({ success: false, error: 'internal_error' });
  }
};

/**
 * POST /api/gate/complete
 * Body: { session_id, origin?, return_to? }
 * - Verifies Stripe session is paid
 * - Ensures Access Pass credit is awarded once per session
 * - Awards partner action (once/day)
 * - Returns redirect_url (frontend can navigate)
 */
const completeGate = async (req, res) => {
  try {
    const { session_id, origin, return_to, email: bodyEmail } = req.body || {};

    if (session_id) {
      console.log('[gate.complete] using session_id:', session_id);
      const session = await stripe.checkout.sessions.retrieve(session_id);

      if (!session) {
        console.error('[gate.complete] session not found');
        return res.status(400).json({ success: false, error: 'session_not_found' });
      }
      if (session.payment_status !== 'paid' && session.status !== 'complete') {
        console.error('[gate.complete] session not paid:', session.payment_status, session.status);
        return res.status(400).json({ success: false, error: 'session_not_paid' });
      }

      await awardAccessPassIfNeededFromSession(session);

      const email =
        session?.metadata?.user_email ||
        session?.customer_details?.email ||
        session?.customer_email;

      const finalOrigin = origin || session?.metadata?.origin;
      const finalReturnKey = return_to || session?.metadata?.return_to || finalOrigin;
      const redirect_url = PARTNER_MAP[finalReturnKey] || PARTNER_MAP[finalOrigin] || '/';

      if (finalOrigin && PARTNER_MAP[finalOrigin]) {
        await awardPartnerOncePerDay(email, finalOrigin);
      }

      return res.json({ success: true, redirect_url });
    }

    if (!session_id && bodyEmail && origin) {
      console.log('[gate.complete] no session_id; checking existing access for', bodyEmail, origin);
      const pass = await hasAccessPass(bodyEmail);
      if (!pass) {
        return res.status(400).json({ success: false, error: 'access_pass_required' });
      }
      await awardPartnerOncePerDay(bodyEmail, origin);
      const redirect_url = PARTNER_MAP[return_to || origin] || '/';
      return res.json({ success: true, redirect_url });
    }

    return res.status(400).json({
      success: false,
      error: 'missing_params',
      message: 'Provide session_id (after Stripe) OR email + origin (if pass already owned).'
    });
  } catch (err) {
    console.error('completeGate error:', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
};


module.exports = { startGate, completeGate };
