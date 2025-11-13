const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('../config/supabase');

/* --------------------------------- Helpers -------------------------------- */

function normEmail(e) {
  return (e || '').trim().toLowerCase();
}

// ensure user exists
async function ensureUser(emailRaw) {
  const email = normEmail(emailRaw);
  const { data, error } = await supabase
    .from('users')
    .upsert([{ email }], { onConflict: 'email' })
    .select()
    .single();
  if (error) console.error('ensureUser error:', error);
  return data;
}

async function bumpUserCredits(emailRaw, deltaCredits) {
  const email = normEmail(emailRaw);
  await ensureUser(email);
  const { data: curr } = await supabase
    .from('users')
    .select('total_credits, total_spent')
    .eq('email', email)
    .maybeSingle();

  const newTotal = (curr?.total_credits || 0) + Number(deltaCredits || 0);
  const { error: updErr } = await supabase
    .from('users')
    .update({ total_credits: newTotal, updated_at: new Date().toISOString() })
    .eq('email', email);
  if (updErr) console.error('update user credits error:', updErr);

  console.log('DEBUG: Credits updated for', email, 'new total:', newTotal);
  return { newTotal, total_spent: curr?.total_spent || 0 };
}


async function bumpUserSpend(emailRaw, deltaUsd) {
  const email = normEmail(emailRaw);
  await ensureUser(email);
  const { data: curr } = await supabase
    .from('users')
    .select('total_spent')
    .eq('email', email)
    .single();

  const newSpent = Number(curr?.total_spent || 0) + Number(deltaUsd || 0);

  const { error: updErr } = await supabase
    .from('users')
    .update({
      total_spent: newSpent,
      updated_at: new Date().toISOString()
    })
    .eq('email', email);

  if (updErr) console.error('update user spend error:', updErr);
  return { newSpent };
}

/* ------------------------------ Auto-Upgrade ------------------------------ */
/**
 * Rule: rolling 30-day spend (USD) >= 99 → grant +49 credits, set full_access=true
 * Idempotency: if a prior 'auto_upgrade_bonus' ledger row exists, don't double-grant.
 */
async function autoUpgradeIfEligible(emailRaw) {
  const email = normEmail(emailRaw);
  try {
    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('full_access, total_spent, auto_upgraded_at')
      .eq('email', email)
      .single();

    if (userErr) {
      console.error('User fetch error during auto-upgrade:', userErr);
      return;
    }

    //  Backfill timestamp if already full_access but missing auto_upgraded_at
    if (userRow?.full_access && !userRow?.auto_upgraded_at) {
      await supabase
        .from('users')
        .update({
          auto_upgraded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('email', email);
      console.log('Backfilled auto_upgraded_at for', email);
      return;
    }

    // If already upgraded (and timestamp exists)
    if (userRow?.full_access && userRow?.auto_upgraded_at) {
      console.log('User already fully upgraded:', email);
      return;
    }

    const now = new Date();
    const thirtyDaysAgoIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch last 30 days of spend
    const { data: recentPurchases, error: spendErr } = await supabase
      .from('credits_ledger')
      .select('amount_usd')
      .eq('email', email)
      .gte('created_at', thirtyDaysAgoIso)
      .lte('created_at', now.toISOString())
      .not('amount_usd', 'is', null);

    if (spendErr) {
      console.error('Spend query error (auto-upgrade):', spendErr);
      return;
    }

    const rollingTotal = (recentPurchases || [])
      .map(r => Number(r.amount_usd || 0))
      .reduce((a, b) => a + b, 0);

    console.log(`30-day rolling spend for ${email}: $${rollingTotal.toFixed(2)}`);

    const totalSpent = Number(userRow?.total_spent || 0);
    const effectiveTotal = Math.max(rollingTotal, totalSpent);

    if (effectiveTotal < 99) {
      console.log(`Not eligible for auto-upgrade (${email}) — total $${effectiveTotal.toFixed(2)} < $99`);
      return;
    }

    // Check if auto-upgrade bonus already exists
    const { data: priorBonus, error: bonusCheckErr } = await supabase
      .from('credits_ledger')
      .select('id')
      .eq('email', email)
      .eq('reason', 'auto_upgrade_bonus')
      .limit(1);

    if (bonusCheckErr) console.error('auto-upgrade prior bonus check error:', bonusCheckErr);

    // Already bonused → ensure full_access and timestamp
    if (priorBonus && priorBonus.length) {
      console.log('ℹAlready bonused, ensuring full_access and auto_upgraded_at');
      await supabase
        .from('users')
        .update({
          full_access: true,
          auto_upgraded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('email', email);
      return;
    }

    // Grant new auto-upgrade bonus
    const bonus = 49;
    const { error: ledgerErrBonus } = await supabase.from('credits_ledger').insert([{
      email,
      delta: bonus,
      reason: 'auto_upgrade_bonus',
      origin_site: 'crowbar_auto_upgrade',
      amount_usd: null,
      created_at: new Date().toISOString(),
    }]);
    if (ledgerErrBonus) console.error('Ledger bonus insert error:', ledgerErrBonus);

    await bumpUserCredits(email, bonus);

    await supabase
      .from('users')
      .update({
        full_access: true,
        auto_upgraded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('email', email);

    console.log(`Auto-upgrade completed for ${email}: +${bonus} credits & full_access=true`);
  } catch (err) {
    console.error('Auto-upgrade check failed:', err);
  }
}



/* --------------------------- Create Checkout Session --------------------------- */
/**
 * Frontend can pass EITHER:
 *  - priceId (recommended)  OR
 *  - product_type: 'crowbar_master' | 'access_pass'
 *
 * If priceId matches your env IDs we set product_type automatically.
 */
const createCheckoutSession = async (req, res) => {
  try {
    const { email, priceId: bodyPriceId, successUrl, cancelUrl } = req.body || {};
    const requestedType = (req.body?.product_type || 'access_pass').toLowerCase();

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid email' });
    }

    const CROWBAR_PRICE = process.env.STRIPE_PRICE_CROWBAR_MASTER; // £39
    const ACCESS_PRICE  = process.env.STRIPE_PRICE_ACCESS_PASS;   // $99
    const CAREDUEL = process.env.STRIPE_PRICE_CAREDUEL; // $10
    const TALENTKONNECT = process.env.STRIPE_PRICE_TALENTKONNECT; // $7
    const ECOWORLDBUY = process.env.STRIPE_PRICE_ECOWORLDBUY; // $7
    const POWEROFAUM = process.env.STRIPE_PRICE_POWEROFAUM;
    // Decide final priceId
    const priceByType = {
      access_pass: ACCESS_PRICE,
      crowbar_master: CROWBAR_PRICE,
      careduel: CAREDUEL,
      talentkonnect: TALENTKONNECT,
      ecoworldbuy: ECOWORLDBUY,
      powerofaum: POWEROFAUM,
    };
    const finalPriceId = bodyPriceId || priceByType[requestedType] || ACCESS_PRICE;

    if (!finalPriceId) {
      return res.status(400).json({ error: 'Missing Stripe price ID (env or body)' });
    }

    // Infer a consistent product_type for metadata based on the chosen priceId
    let inferredType = requestedType;
    if (finalPriceId === CROWBAR_PRICE) inferredType = 'crowbar_master';
    if (finalPriceId === ACCESS_PRICE)  inferredType = 'access_pass';
    if (finalPriceId === CAREDUEL)  inferredType = 'careduel';
    if (finalPriceId === TALENTKONNECT)  inferredType = 'talentkonnect';
    if (finalPriceId === ECOWORLDBUY)  inferredType = 'ecoworldbuy';
    if (finalPriceId === POWEROFAUM) inferredType = 'powerofaum';

    console.log('Creating Stripe session for:', email, 'product_type:', inferredType, 'priceId:', finalPriceId);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: finalPriceId, quantity: 1 }],
      mode: 'payment',
      success_url: successUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancelUrl  || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-cancel`,
      customer_email: normEmail(email),
      metadata: { user_email: normEmail(email), product_type: inferredType },
    });

    console.log('Stripe session created:', session.id, 'for', inferredType);
    res.json({ success: true, sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
};

/* ----------------------------- Retrieve Session ----------------------------- */
const getSessionStatus = async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('Checking session:', sessionId);

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });

    res.json({
      success: true,
      session: {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        customer_email: session?.customer_details?.email || session?.customer_email || null,
        amount_total: session.amount_total ? session.amount_total / 100 : 0,
        currency: (session.currency || '').toLowerCase() || 'usd',
        payment_intent: session.payment_intent?.id || null,
      },
    });
  } catch (error) {
    console.error('Session check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/* ----------------------- Handle Successful Payment Core ---------------------- */
/**
 * - Idempotent via stripe_event_id check
 * - Writes ledger, bumps credits & spend (once)
 * - Sets crowbar_access for Crowbar purchases (by metadata OR price OR amount fallback)
 * - Runs auto-upgrade rule
 */
const handleSuccessfulPayment = async (session, sourceEventId = null) => {
  try {
    const rawEmail =
      session?.metadata?.user_email ||
      session?.customer_details?.email ||
      session?.customer_email;
    const email = normEmail(rawEmail);
    if (!email) {
      console.error('No user email on session:', session?.id);
      return;
    }

    const sessionId = session?.id || null;
    const amountCents = Number.isFinite(session?.amount_total) ? Number(session.amount_total) : NaN;
    const currency = (session?.currency || '').toLowerCase();
    const metaProduct = (session?.metadata?.product_type || 'access_pass').toLowerCase();
    const usd = Number.isFinite(amountCents) ? amountCents / 100 : 0;

    console.log(`Processing payment for ${email} — session=${sessionId}, event=${sourceEventId}`);

    let isCrowbarByPrice = false;
    try {
      const expanded = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['line_items.data.price']
      });
      const priceIds = expanded?.line_items?.data?.map(li => li?.price?.id).filter(Boolean) || [];
      const crowbarPriceId = process.env.STRIPE_PRICE_CROWBAR_MASTER;
      if (crowbarPriceId && priceIds.includes(crowbarPriceId)) isCrowbarByPrice = true;
    } catch (e) {
      console.warn('Could not expand line_items:', e?.message || e);
    }

    const isCrowbarByAmount = !Number.isNaN(amountCents) && amountCents === 3900 && ['usd', 'gbp'].includes(currency);
    const isCrowbar = metaProduct === 'crowbar_master' || isCrowbarByPrice || isCrowbarByAmount;

    const map = {
      access_pass: 49,
      crowbar_master: 49,
      talentkonnect: 7,
      careduel: 3,
      ecoworldbuy: 7,
      powerofaum:3,

    };

    const productForCredits = isCrowbar ? 'crowbar_master' : metaProduct;
    const credits = map[productForCredits] ?? 0;

    console.log(` Product=${productForCredits}, credits=${credits}, usd=${usd}`);

    /* ------------------------------------------------------------------
       1️⃣ Hard guard – do nothing if credits <= 0
       (do NOT even insert a ledger row)
    ------------------------------------------------------------------ */
    if (!credits || credits <= 0) {
      console.warn(`Skipping transaction for ${email} — invalid/zero credits (${credits})`);
      return;
    }

    /* ------------------------------------------------------------------
       2️⃣ Check if a *valid* ledger already exists (delta>0)
    ------------------------------------------------------------------ */
    const { data: priorValid, error: priorValidErr } = await supabase
      .from('credits_ledger')
      .select('id, delta')
      .eq('stripe_session_id', sessionId)
      .gte('delta', 1)
      .limit(1);
    if (priorValidErr) console.error('Ledger valid-check error:', priorValidErr);
    if (priorValid && priorValid.length) {
      console.log(`🔄 Skipping: valid ledger already exists for session=${sessionId}`);
      return;
    }

    /* ------------------------------------------------------------------
       3️⃣ Insert ledger row (only positive credits)
    ------------------------------------------------------------------ */
    const { error: insLedgerErr } = await supabase
      .from('credits_ledger')
      .insert([{
        email,
        delta: credits,
        reason: 'checkout.session.completed',
        origin_site: productForCredits,
        stripe_event_id: sourceEventId || null,
        stripe_session_id: sessionId || null,
        amount_usd: usd || null,
        created_at: new Date().toISOString(),
      }]);
    if (insLedgerErr) {
      console.error('Ledger insert error:', insLedgerErr);
      return;
    }
    console.log(`Ledger entry recorded for ${email}, session=${sessionId}`);

    /* ------------------------------------------------------------------
       4️⃣ Credits table – skip if existing for this session
    ------------------------------------------------------------------ */
    const { data: existingCredit, error: creditErr } = await supabase
      .from('credits')
      .select('id')
      .eq('stripe_session_id', sessionId)
      .limit(1);
    if (creditErr) console.error('credit check error:', creditErr);
    if (!existingCredit?.length) {
      const { error: insCreditErr } = await supabase
        .from('credits')
        .insert([{
          email,
          amount: credits,
          origin_site: productForCredits,
          eligible_global_race: productForCredits === 'access_pass',
          legal_accept: true,
          stripe_event_id: sourceEventId || null,
          stripe_session_id: sessionId || null,
          created_at: new Date().toISOString(),
        }]);
      if (insCreditErr) console.error('Credits insert error:', insCreditErr);
      else console.log(`Credits inserted for ${email} (${productForCredits}) amount=${credits}`);
    } else {
      console.log(`Skipping duplicate credits insert for ${email} (session=${sessionId})`);
    }

    /* ------------------------------------------------------------------
       5️⃣ Crowbar flag + user updates
    ------------------------------------------------------------------ */
 if (metaProduct === 'crowbar_master') {
  await supabase
    .from('users')
    .update({
      crowbar_access: true,
      updated_at: new Date().toISOString(),
    })
    .eq('email', email);
}

if (metaProduct === 'access_pass') {
  await supabase
    .from('users')
    .update({
      crowbar_access: true,
      full_access: true,
      access_careduel: true,
      access_ecoworldbuy: true,
      access_talentkonnect: true,
      access_powerofaum:true,
      updated_at: new Date().toISOString(),
    })
    .eq('email', email);
}

if (metaProduct === 'careduel') {
  await supabase
    .from('users')
    .update({
      access_careduel: true,
      updated_at: new Date().toISOString(),
    })
    .eq('email', email);
}

if (metaProduct === 'ecoworldbuy') {
  await supabase
    .from('users')
    .update({
      access_ecoworldbuy: true,
      updated_at: new Date().toISOString(),
    })
    .eq('email', email);
}

if (metaProduct === 'talentkonnect') {
  await supabase
    .from('users')
    .update({
      access_talentkonnect: true,
      updated_at: new Date().toISOString(),
    })
    .eq('email', email);
}

if (metaProduct === 'powerofaum') {
  await supabase
    .from('users')
    .update({
      access_powerofaum: true,
      updated_at: new Date().toISOString(),
    })
    .eq('email', email);
}

    await bumpUserCredits(email, credits);
    if (usd > 0) await bumpUserSpend(email, usd);
    await autoUpgradeIfEligible(email);

    console.log(`Payment completed for ${email} — +${credits} credits, +$${usd} spend`);
  } catch (error) {
    console.error('Payment handling error:', error);
  }
};



const testManualPayment = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const mockSession = {
      id: 'cs_test_' + Math.random().toString(36).slice(2),
      metadata: { user_email: email, product_type: 'access_pass' },
      customer_email: email,
      amount_total: 9900, 
      currency: 'usd'
    };

    await handleSuccessfulPayment(mockSession, `manual:${mockSession.id}`);
    res.json({ success: true, message: 'Manual payment test completed', email });
  } catch (error) {
    console.error('Manual test error:', error);
    res.status(500).json({ error: error.message });
  }
};

/* --------------------------------- Webhook --------------------------------- */
/**
 * Verify signature, enforce idempotency (credits_ledger.stripe_event_id),
 * and dispatch to handleSuccessfulPayment.
 */
const handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('Webhook received:', event.type, 'Event ID:', event.id);
  } catch (err) {
    console.error(' Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Global idempotency check (defense-in-depth)
  console.log('Checking for duplicate event at webhook level:', event.id);
  const { data: existingEvent, error: checkError } = await supabase
    .from('credits_ledger')
    .select('id, email, stripe_event_id')
    .eq('stripe_event_id', event.id)
    .maybeSingle();

  if (checkError) {
    console.error('Error checking for duplicates in webhook:', checkError);
  }

  if (existingEvent) {
    console.log(' WEBHOOK DUPLICATE: Already processed event:', event.id, 'for email:', existingEvent.email);
    console.log('Returning 200 to Stripe without processing');
    return res.json({ received: true, status: 'already_processed', event_id: event.id });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('Checkout session completed:', session.id, 'Payment status:', session.payment_status);
        if (session.payment_status === 'paid' || session.status === 'complete') {
          await handleSuccessfulPayment(session, event.id);
        } else {
          console.log('ℹSession not paid yet:', session.id, session.payment_status);
        }
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        console.log('Async payment succeeded:', session.id);
        await handleSuccessfulPayment(session, event.id);
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        console.log(' PaymentIntent succeeded (ignored for credits path):', pi.id);
        break;
      }
      default:
        console.log(`ℹ Unhandled event type: ${event.type}`);
    }

    console.log('Webhook processing completed for event:', event.id);
    res.json({ received: true, status: 'processed', event_id: event.id });
  } catch (err) {
    console.error(' Webhook handler error:', err);
    res.status(500).send('Webhook handler error');
  }
};


const getUserAccess = async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required' });
    }

    const { data, error } = await supabase
      .from('users')
      .select(
        'email, total_spent, total_credits, full_access, crowbar_access, access_careduel, access_ecoworldbuy, access_talentkonnect, access_powerofaum, auto_upgraded_at, updated_at'
      )
      .eq('email', email)
      .single();

    if (error) {
      console.error('getUserAccess error:', error);
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, user: data });
  } catch (err) {
    console.error('getUserAccess catch:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/* ------------------------------------------------------------------
   🔗 SYNC USER FROM BRAND SITE (EcoWorldBuy, CareDuel, TalentKonnect)
------------------------------------------------------------------ */
const syncUserAccess = async (req, res) => {
  try {
    const { email, product_type } = req.body || {};
    if (!email || !product_type) {
      return res.status(400).json({ error: 'Missing email or product_type' });
    }

    const normEmail = (email || '').trim().toLowerCase();
    const now = new Date().toISOString();

    let updateData = { updated_at: now };

    if (product_type === 'ecoworldbuy') updateData.access_ecoworldbuy = true;
    if (product_type === 'careduel') updateData.access_careduel = true;
    if (product_type === 'talentkonnect') updateData.access_talentkonnect = true;
    if (product_type === 'crowbar_master') updateData.crowbar_access = true;
    if (product_type === 'powerofaum') updateData.access_powerofaum = true;

    const { error } = await supabase
      .from('users')
      .upsert([{ email: normEmail, ...updateData }], { onConflict: 'email' });

    if (error) {
      console.error('syncUserAccess error:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Synced user access for ${normEmail} [${product_type}]`);
    res.json({ success: true, email: normEmail, updated: updateData });
  } catch (err) {
    console.error('syncUserAccess failed:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
};

module.exports = {
  createCheckoutSession,
  handleWebhook,
  getSessionStatus,
  testManualPayment,
  getUserAccess,
  syncUserAccess,
};
