const { supabase } = require('../config/supabase');

// Security: simple shared-secret check
function requireBridgeAuth(req, res) {
  const incoming = req.headers['x-bridge-token'];
  const expected = process.env.BRIDGE_SHARED_SECRET;
  if (!expected || incoming !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function normEmail(e) {
  return (e || '').trim().toLowerCase();
}

async function ensureUser(email) {
  const { data, error } = await supabase
    .from('users')
    .upsert([{ email }], { onConflict: 'email' })
    .select()
    .single();
  if (error) console.error('ensureUser error:', error);
  return data;
}

// Small helpers
async function bumpUserCredits(email, delta) {
  await ensureUser(email);
  const { data: curr } = await supabase
    .from('users')
    .select('total_credits')
    .eq('email', email)
    .maybeSingle();

  const newTotal = (curr?.total_credits || 0) + Number(delta || 0);
  const { error: updErr } = await supabase
    .from('users')
    .update({ total_credits: newTotal, updated_at: new Date().toISOString() })
    .eq('email', email);
  if (updErr) console.error('update credits error:', updErr);
  return newTotal;
}

async function bumpUserSpend(email, deltaUsd) {
  await ensureUser(email);
  const { data: curr } = await supabase
    .from('users')
    .select('total_spent')
    .eq('email', email)
    .maybeSingle();

  const newSpent = Number(curr?.total_spent || 0) + Number(deltaUsd || 0);
  const { error: updErr } = await supabase
    .from('users')
    .update({ total_spent: newSpent, updated_at: new Date().toISOString() })
    .eq('email', email);
  if (updErr) console.error('update spend error:', updErr);
  return newSpent;
}


async function autoUpgradeIfEligible(email) {
  try {
    // rolling 30-day from credits_ledger
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const end = now.toISOString();

    const { data: rows } = await supabase
      .from('credits_ledger')
      .select('amount_usd')
      .eq('email', email)
      .gte('created_at', start)
      .lte('created_at', end)
      .not('amount_usd', 'is', null);

    const rolling = (rows || []).reduce((a, r) => a + Number(r.amount_usd || 0), 0);

    const { data: userRow } = await supabase
      .from('users')
      .select('total_spent, full_access, auto_upgraded_at')
      .eq('email', email)
      .single();

    const effective = Math.max(rolling, Number(userRow?.total_spent || 0));

    if (userRow?.full_access && userRow?.auto_upgraded_at) return;
    if (effective < 99) return;

    // Check if bonus already exists
    const { data: prior } = await supabase
      .from('credits_ledger')
      .select('id')
      .eq('email', email)
      .eq('reason', 'auto_upgrade_bonus')
      .limit(1);

    if (!prior?.length) {
      // grant +49 once
      await supabase.from('credits_ledger').insert([{
        email,
        delta: 49,
        reason: 'auto_upgrade_bonus',
        origin_site: 'bridge_auto_upgrade',
        amount_usd: null,
        created_at: new Date().toISOString(),
      }]);
      await bumpUserCredits(email, 49);
    }

    await supabase
      .from('users')
      .update({
        full_access: true,
        auto_upgraded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('email', email);
  } catch (e) {
    console.error('autoUpgradeIfEligible error:', e);
  }
}

/**
 * POST /api/bridge/sync-login
 * Body: { email: string, source_brand: 'ecoworldbuy' | 'careduel' | 'talentkonnect' }
 * Effect: upsert user, set last_login_* fields. For EcoWorldBuy we ONLY log the login here.
 */
const syncLogin = async (req, res) => {
  try {
    if (!requireBridgeAuth(req, res)) return;

    const email = normEmail(req.body?.email);
    const source = String(req.body?.source_brand || '').toLowerCase();

    if (!email || !source) {
      return res.status(400).json({ error: 'email and source_brand are required' });
    }

    await ensureUser(email);
    await supabase
      .from('users')
      .update({
        last_login_at: new Date().toISOString(),
        last_login_brand: source,
        updated_at: new Date().toISOString(),
      })
      .eq('email', email);

    return res.json({ success: true, email, source });
  } catch (e) {
    console.error('syncLogin error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /api/bridge/sync-checkout
 * Body:
 * {
 *   email: string,
 *   source_brand: 'ecoworldbuy'|'careduel'|'talentkonnect',
 *   amount_cents: number,               // 700 for $7, 500 for $5, etc.
 *   credits_delta: number,              // Credits awarded by the brand logic (e.g., floor($/5)*5)
 *   stripe_session_id?: string,         // Optional for idempotency
 *   idempotency_key?: string,           // Optional fallback idempotency
 *   unlock?: boolean                    // true for EcoWorldBuy initial $7 unlock
 * }
 *
 * Effect:
 *  - Idempotency guard (by session_id or idempotency_key)
 *  - Insert credits_ledger (delta = credits_delta, origin_site=source_brand)
 *  - Insert credits row (if not already for same session)
 *  - Update users: access_ecoworldbuy=true if unlock === true (for source_brand 'ecoworldbuy')
 *  - Bump totals + auto-upgrade check
 */
const syncCheckout = async (req, res) => {
  try {
    if (!requireBridgeAuth(req, res)) return;

    const email = normEmail(req.body?.email);
    const source = String(req.body?.source_brand || '').toLowerCase(); // 'ecoworldbuy' | 'careduel' | 'talentkonnect'
    const amount_cents = Number(req.body?.amount_cents || 0);
    const credits_delta = Number(req.body?.credits_delta || 0);
    const stripe_session_id = req.body?.stripe_session_id || null;
    const idempotency_key = req.body?.idempotency_key || null;
    const unlock = Boolean(req.body?.unlock);

    if (!email || !source) {
      return res.status(400).json({ error: 'email and source_brand are required' });
    }
    if (credits_delta <= 0 && !unlock) {
      return res.status(400).json({ error: 'credits_delta must be > 0 unless unlock=true' });
    }

    await ensureUser(email);

    // Idempotency guard
    if (stripe_session_id) {
      const { data: prior } = await supabase
        .from('credits_ledger')
        .select('id')
        .eq('stripe_session_id', stripe_session_id)
        .gte('delta', 1)
        .limit(1);
      if (prior?.length) {
        return res.json({ success: true, idempotent: true, reason: 'session already processed' });
      }
    } else if (idempotency_key) {
      const { data: prior } = await supabase
        .from('credits_ledger')
        .select('id')
        .eq('reason', idempotency_key) // using reason as a simple storage for custom key
        .gte('delta', 1)
        .limit(1);
      if (prior?.length) {
        return res.json({ success: true, idempotent: true, reason: 'idempotency_key already processed' });
      }
    }

    const amount_usd = Math.round((amount_cents || 0)) / 100;

    // Insert ledger (only if credits_delta > 0)
    if (credits_delta > 0) {
      const { error: lerr } = await supabase.from('credits_ledger').insert([{
        email,
        delta: credits_delta,
        reason: idempotency_key || 'bridge.sync_checkout',
        origin_site: source,
        stripe_event_id: null,
        stripe_session_id: stripe_session_id,
        amount_usd,
        created_at: new Date().toISOString(),
      }]);
      if (lerr) {
        console.error('ledger insert error:', lerr);
        return res.status(500).json({ error: 'ledger insert failed' });
      }
    }

    // Insert credits row once per session (if provided)
    if (stripe_session_id) {
      const { data: existingCredit } = await supabase
        .from('credits')
        .select('id')
        .eq('stripe_session_id', stripe_session_id)
        .limit(1);

      if (!existingCredit?.length && credits_delta > 0) {
        const { error: cerr } = await supabase.from('credits').insert([{
          email,
          amount: credits_delta,
          origin_site: source,
          eligible_global_race: false,     
          legal_accept: true,
          stripe_event_id: null,
          stripe_session_id,
          created_at: new Date().toISOString(),
        }]);
        if (cerr) console.error('credits insert error:', cerr);
      }
    }

    // Access flag for EcoWorldBuy initial unlock
    if (source === 'ecoworldbuy' && unlock === true) {
      const { error: aerr } = await supabase
        .from('users')
        .update({
          access_ecoworldbuy: true,
          updated_at: new Date().toISOString(),
        })
        .eq('email', email);
      if (aerr) console.error('update access_ecoworldbuy error:', aerr);
    }

    // Bump totals
    if (credits_delta > 0) await bumpUserCredits(email, credits_delta);
    if (amount_usd > 0) await bumpUserSpend(email, amount_usd);

    await autoUpgradeIfEligible(email);

    return res.json({
      success: true,
      email,
      source,
      credits_added: credits_delta,
      amount_usd,
      unlock_applied: source === 'ecoworldbuy' && unlock === true,
    });
  } catch (e) {
    console.error('syncCheckout error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  syncLogin,
  syncCheckout,
};
