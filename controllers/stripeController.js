const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('../config/supabase');


// helper: ensure user row exists
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
  const { data: curr } = await supabase
    .from('users')
    .select('total_credits, total_spent')
    .eq('email', email)
    .single();
  const newTotal = (curr?.total_credits || 0) + deltaCredits;
  const { error: updErr } = await supabase
    .from('users')
    .update({ total_credits: newTotal, updated_at: new Date().toISOString() })
    .eq('email', email);
  if (updErr) console.error('update user credits error:', updErr);
  return { newTotal, total_spent: curr?.total_spent || 0 };
}
async function bumpUserSpend(email, deltaUsd) {
  await ensureUser(email);
  const { data: curr } = await supabase
    .from('users')
    .select('total_spent, full_access')
    .eq('email', email)
    .single();
  const newSpent = Number(curr?.total_spent || 0) + Number(deltaUsd || 0);
  const full_access = newSpent >= 99; // rule from client brief
  const { error: updErr } = await supabase
    .from('users')
    .update({
      total_spent: newSpent,
      full_access,
      updated_at: new Date().toISOString()
    })
    .eq('email', email);
  if (updErr) console.error('update user spend error:', updErr);
  return { newSpent, full_access };
}

/**
 * Create Checkout Session (test price)
 */
const createCheckoutSession = async (req, res) => {
  try {
    const { email } = req.body;
    console.log('🔄 Creating Stripe session for:', email);
    const testPriceId = process.env.STRIPE_PRICE_ACCESS_PASS || 'price_1SNsAuQZJXcO4yAMKXAehmNP';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: testPriceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-cancel`,
      customer_email: email,
      metadata: { user_email: email, product_type: 'access_pass' },
    });

    console.log('✅ Stripe session created:', session.id);
    res.json({ success: true, sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('❌ Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Retrieve Session Status
 */
const getSessionStatus = async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('🔍 Checking session:', sessionId);

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });

    res.json({
      success: true,
      session: {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        customer_email: session?.customer_details?.email || session?.customer_email || null,
        amount_total: session.amount_total ? session.amount_total / 100 : 0,
        currency: session.currency || 'usd',
        payment_intent: session.payment_intent?.id || null,
      },
    });
  } catch (error) {
    console.error('❌ Session check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Add credits + ledger + users totals
 */
const handleSuccessfulPayment = async (session, sourceEventId = null) => {
  try {
    const email =
      session?.metadata?.user_email ||
      session?.customer_details?.email ||
      session?.customer_email;
    if (!email) {
      console.error('❌ No user email on session:', session?.id);
      return;
    }

    const product = (session?.metadata?.product_type || 'access_pass').toLowerCase();
    const map = {
      access_pass: 49,
      talentkonnect: 7,
      careduel: 3,
      ecoworldbuy: 7,
    };
    const credits = map[product] ?? 0;

    // 1) legacy table record
    await supabase.from('credits').insert([{
      email,
      amount: credits,
      origin_site: product,
      eligible_global_race: product === 'access_pass',
      legal_accept: true
    }]);

    // 2) ledger record
    await supabase.from('credits_ledger').insert([{
      email,
      delta: credits,
      reason: 'checkout.session.completed',
      origin_site: product,
      stripe_event_id: sourceEventId || null,
      stripe_session_id: session.id,
      amount_usd: session.amount_total ? session.amount_total / 100 : null
    }]);

    // 3) bump user credits
    await bumpUserCredits(email, credits);

    // 4) bump user spend in USD (if amount known)
    const usd = session.amount_total ? session.amount_total / 100 : 0;
    if (usd) await bumpUserSpend(email, usd);

    console.log(`✅ Credits ${credits} granted to ${email} for ${product}`);
  } catch (error) {
    console.error('❌ Payment handling error:', error);
  }
};

/**
 * Manual test endpoint
 */
const testManualPayment = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const mockSession = {
      id: 'cs_test_' + Math.random().toString(36).slice(2),
      metadata: { user_email: email, product_type: 'access_pass' },
      customer_email: email,
      amount_total: 4900
    };

    await handleSuccessfulPayment(mockSession, `manual:${mockSession.id}`);
    res.json({ success: true, message: 'Manual payment test completed', email });
  } catch (error) {
    console.error('❌ Manual test error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * SECURE Webhook
 */
const handleWebhook = async (req, res) => {
  console.log('🔔 Webhook received');
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status === 'paid' || session.status === 'complete') {
          await handleSuccessfulPayment(session, event.id);
        } else {
          console.log('ℹ️ Session not paid yet:', session.id, session.payment_status);
        }
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        await handleSuccessfulPayment(session, event.id);
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        console.log('✅ PaymentIntent succeeded:', pi.id);
        break;
      }
      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook handler error:', err);
    res.status(500).send('Webhook handler error');
  }
};

module.exports = {
  createCheckoutSession,
  handleWebhook,
  getSessionStatus,
  testManualPayment,
};
