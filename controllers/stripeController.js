const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('../config/supabase');
const { ensureReferralCodeForUser } = require('../utils/referrals');

/* --------------------------------- Helpers -------------------------------- */

// Normalize email
function normEmail(e) {
  return (e || '').trim().toLowerCase();
}

// Ensure user exists or create new user
async function ensureUser(emailRaw) {
  const email = normEmail(emailRaw);
  const { data, error } = await supabase
    .from('users')
    .upsert([{ email }], { onConflict: 'email' })
    .select()
    .single();
  
  if (error) {
    console.error('ensureUser error:', error);
    throw new Error(`Failed to ensure user: ${error.message}`);
  }
  return data;
}

// Update user credits
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

// Update user spend
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

/* ------------------------------ File Upload ------------------------------ */
async function uploadFile(fileData, fileName, email) {
  try {
    // Check if fileData is a URL (already uploaded) or needs upload
    if (fileData.startsWith('http')) {
      return fileData; // Already a URL, return as-is
    }

    // Handle base64 file data
    if (fileData.startsWith('data:')) {
      const matches = fileData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        throw new Error('Invalid base64 file data');
      }
      
      const buffer = Buffer.from(matches[2], 'base64');
      const fileExtension = matches[1].split('/')[1] || 'jpg';
      const filePath = `kyc-docs/${email}/${Date.now()}-${fileName}.${fileExtension}`;
      
      const { data, error } = await supabase.storage
        .from('kyc-documents')
        .upload(filePath, buffer, {
          contentType: matches[1],
          upsert: false
        });

      if (error) throw error;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('kyc-documents')
        .getPublicUrl(filePath);

      return publicUrl;
    } else {
      // Handle binary file data or other formats
      throw new Error('Unsupported file format. Please use base64 or URL.');
    }
  } catch (error) {
    console.error('File upload error:', error);
    throw new Error(`Failed to upload file ${fileName}: ${error.message}`);
  }
}

/* ------------------------------ Age-Discount Logic ------------------------------ */
async function applyAgeDiscount(email, ageRange, files) {
  try {
    if (ageRange === 'Under 25' || ageRange === 'Over 60') {
      // Validate required files for KYC
      if (!files || !files.id_doc_url || !files.selfie_url || !files.social_url) {
        throw new Error('Government ID, live selfie, and social media link are required for age verification');
      }

      // Upload files and get URLs
      const idDocUrl = await uploadFile(files.id_doc_url, 'government_id', email);
      const selfieUrl = await uploadFile(files.selfie_url, 'live_selfie', email);
      const socialUrl = files.social_url; // Store as text link

      // Store KYC info in database
      const { error } = await supabase
        .from('users')
        .update({
          kyc_status: "pending",
          id_doc_url: idDocUrl,
          selfie_url: selfieUrl,
          social_url: socialUrl,
          age_range: ageRange,
          age_verified: false, // Manual verification required
          updated_at: new Date().toISOString()
        })
        .eq('email', email);

      if (error) throw error;

      console.log(`Age discount KYC documents stored for ${email}`);
      return { success: true, discountApplied: true };
    }

    return { success: true, discountApplied: false, message: "Not eligible for age discount" };
  } catch (error) {
    console.error('Age discount error:', error);
    return { success: false, error: error.message };
  }
}

/* --------------------------- Create Checkout Session --------------------------- */
const createCheckoutSession = async (req, res) => {
  try {
    const { email, tier, successUrl, cancelUrl, ageRange, files } = req.body || {};

    // Validate email
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    // Validate tier
    const validTiers = ['discount19', 'basic', 'pro', 'elite'];
    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({ error: 'Valid tier is required: discount19, basic, pro, or elite' });
    }

    let finalPriceId;
    let productType = 'crowbar_master';

    // Handle different tiers and age discount logic
  if (tier === 'discount19') {
  // Check if user is already age verified (pre-verified from frontend)
  if (ageRange === 'pre_verified') {
    // User is already KYC verified - skip document validation and apply discount directly
    const user = await supabase
      .from('users')
      .select('age_verified, kyc_status')
      .eq('email', email)
      .single();

    if (user.data?.age_verified && user.data?.kyc_status === 'approved') {
      finalPriceId = process.env.STRIPE_PRICE_DISCOUNT_19;
      console.log(`Pre-verified user ${email} accessing discount tier, using $19 price`);
    } else {
      return res.status(400).json({ error: 'User not eligible for discount tier' });
    }
  } else {
    // New user needs to complete age verification
    // Validate age range for discount tier
    if (!ageRange || (ageRange !== 'Under 25' && ageRange !== 'Over 60')) {
      return res.status(400).json({ error: 'Age verification required for discount tier (Under 25 or Over 60)' });
    }

    // Validate KYC files for discount tier
    if (!files || !files.id_doc_url || !files.selfie_url || !files.social_url) {
      return res.status(400).json({ error: 'Government ID, live selfie, and social media link required for discount tier' });
    }

    // Apply discount and process KYC
    const { success, discountApplied, error } = await applyAgeDiscount(email, ageRange, files);
    
    if (!success) {
      return res.status(400).json({ error: error || 'Failed to process age verification' });
    }
    
    if (discountApplied) {
      finalPriceId = process.env.STRIPE_PRICE_DISCOUNT_19;
      console.log(`Discount tier selected for ${email}, using $19 price`);
    } else {
      return res.status(400).json({ error: 'Not eligible for discount tier' });
    }
  }
} else {
  // Regular tiers without discount logic
  const priceMap = {
    'basic': process.env.STRIPE_PRICE_BASIC_49,    // $49 for basic tier
    'pro': process.env.STRIPE_PRICE_PRO_99,        // $99 for pro tier
    'elite': process.env.STRIPE_PRICE_ELITE_499    // $499 for elite tier
  };
  
  finalPriceId = priceMap[tier];
  if (!finalPriceId) {
    return res.status(400).json({ error: 'Invalid tier selected' });
  }
}
    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: finalPriceId, quantity: 1 }],
      mode: 'payment',
      success_url: successUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-cancel`,
      customer_email: normEmail(email), // Normalized email for customer
      metadata: {
        user_email: normEmail(email),
        product_type: productType, // Set product type
        membership_tier: tier, // Set tier type
        age_range: ageRange || 'Not provided' // Add age range if applicable
      },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // Expires in 30 minutes
    });

    console.log(`Checkout session created for ${email}, Tier: ${tier}, Session ID: ${session.id}`);
    
    res.json({ 
      success: true, 
      sessionId: session.id, 
      url: session.url,
      priceId: finalPriceId,
      tier: tier
    });
    
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: error.message 
    });
  }
};



const handleSuccessfulPayment = async (session, sourceEventId = null) => {
  try {
    console.log('🔍 START handleSuccessfulPayment');
    console.log('Session ID:', session?.id);
    console.log('Source Event ID:', sourceEventId);
    
    const email = normEmail(session?.metadata?.user_email || session?.customer_email);
    if (!email) {
      console.error('❌ No user email on session:', session?.id);
      return { success: false, error: 'No email' };
    }

    const sessionId = session?.id;
    const amountCents = Number.isFinite(session?.amount_total) ? session.amount_total : 0;
    const usd = amountCents / 100;

    // Get tier from metadata
    const tier = session?.metadata?.membership_tier || 'basic';
    console.log('📧 Processing payment for:', email, 'Tier:', tier, 'Amount:', usd);

    // Tier benefits - ensure credits are integers
    const tierBenefits = {
      discount19: { credits: 49, entries: 1, credit_multiplier: 1.0, membership_tier: 'discount19' },
      basic: { credits: 49, entries: 1, credit_multiplier: 1.0, membership_tier: 'basic' },
      pro: { credits: 49, entries: 3, credit_multiplier: 1.5, membership_tier: 'pro' },
      elite: { credits: 500, entries: 10, credit_multiplier: 1.5, membership_tier: 'elite', refund_on_event_end: 250 }
    };

    const safeTier = tierBenefits[tier] ? tier : 'basic';
    const benefits = tierBenefits[safeTier];
    
    // CRITICAL FIX: must be let, NOT const
    let deltaCredits = Math.floor(benefits?.credits || 49);

    if (deltaCredits <= 0) {
      console.error('❌ CRITICAL: Invalid delta credits:', deltaCredits, 'using default 49');
      deltaCredits = 49;
    }
    
    console.log('💰 Benefits:', benefits, 'Delta Credits:', deltaCredits);

    // ----- Existing ledger check -----
    let existingLedgerRecord = null;
    if (sourceEventId) {
      const { data } = await supabase
        .from('credits_ledger')
        .select('id, delta, reason, created_at')
        .eq('stripe_event_id', sourceEventId)
        .maybeSingle();
      
      if (data) {
        existingLedgerRecord = data;
        console.log('⚠️ Found existing ledger record:', data);
      }
    }

    if (existingLedgerRecord) {
      console.log('⏭️ Payment already processed in ledger');
      
      const { data: user } = await supabase
        .from('users')
        .select('total_credits, membership_tier')
        .eq('email', email)
        .single();
      
      console.log('👤 User current state:', user);
      
      return { success: true, alreadyProcessed: true, existingLedgerId: existingLedgerRecord.id };
    }

    // ----- Update user -----
    const { data: existingUser } = await supabase
      .from('users')
      .select('total_credits, total_spent, membership_tier')
      .eq('email', email)
      .maybeSingle();

    const prevCredits = existingUser?.total_credits || 0;
    const newTotalCredits = prevCredits + deltaCredits;

    const nowIso = new Date().toISOString();

    const userUpdate = {
      email,
      membership_tier: benefits.membership_tier,
      membership_activated_at: nowIso,
      entries_available: benefits.entries,
      credit_multiplier: benefits.credit_multiplier,
      total_credits: newTotalCredits,
      updated_at: nowIso,
      ...(tier === 'elite' && {
        elite_prep_access: true,
        vip_onboarding: true,
        marketplace_priority: true,
        refund_on_event_end: benefits.refund_on_event_end || 250
      }),
      ...(tier === 'pro' && {
        priority_challenge: true,
        pro_welcome_perk: true
      }),
      crowbar_access: true,
      full_access: tier === 'pro' || tier === 'elite'
    };

    const { error: userError } = await supabase
      .from('users')
      .upsert(userUpdate, { onConflict: 'email' });

    if (userError) throw userError;

    // ----- Track spend -----
    await bumpUserSpend(email, usd);

    // ----- Insert into CREDITS -----
    const creditsData = {
      email: email,
      amount: deltaCredits,
      origin_site: 'stripe_payment',
      stripe_event_id: sourceEventId,
      stripe_session_id: sessionId,
      eligible_global_race: true,
      legal_accept: true,
      created_at: nowIso
    };
    
    await supabase.from('credits').insert(creditsData);

    // ----- Insert into CREDITS_LEDGER (THIS WAS FAILING) -----
    const ledgerData = {
      email: email,
      stripe_session_id: sessionId,
      amount_usd: usd,
      delta: deltaCredits,
      reason: `membership_purchase_${tier}`,
      origin_site: 'stripe_payment',
      stripe_event_id: sourceEventId,
      created_at: nowIso
    };

    console.log("🟦 Ledger Insert Payload:", ledgerData);
    console.log("🔥 BEFORE INSERT — delta:", deltaCredits, "usd:", usd, "reason:", `membership_purchase_${tier}`);


    const { data: ledgerResult, error: ledgerError } = await supabase
      .from('credits_ledger')
      .insert(ledgerData);
      

    if (ledgerError) {
  console.error('❌ CREDITS_LEDGER insert FAILED:', ledgerError);

  if (ledgerError.code !== '23505') {
    throw ledgerError;
  }

  console.log("ℹ️ Duplicate stripe_event_id ignored");
}

    // ----- Referral code -----
    try {
      await ensureReferralCodeForUser(supabase, email);
    } catch {}

    return {
      success: true,
      ledgerInserted: true,
      creditsInserted: true,
      email,
      tier,
      deltaCredits,
      ledgerId: ledgerResult?.[0]?.id
    };
    
  } catch (error) {
    console.error('❌ Payment handling ERROR:', error);
    return { success: false, error: error.message };
  }
};



/* ----------------------------- Webhook --------------------------------- */
/* ----------------------------- Webhook --------------------------------- */
const handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('🔔 Webhook received:', event.type, 'Event ID:', event.id);
  } catch (err) {
    console.error('❌ Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Immediately respond to Stripe to prevent timeouts
  res.json({ 
    received: true, 
    status: 'processing', 
    event_id: event.id,
    event_type: event.type 
  });

  // Process the webhook asynchronously
  processWebhookEvent(event).catch(error => {
    console.error('❌ Async webhook processing failed:', error);
  });
};

/* --------------------------- Async Webhook Processor --------------------------- */
const processWebhookEvent = async (event) => {
  try {
    console.log('🔄 Processing webhook event asynchronously:', event.type, event.id);

    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('💰 Checkout session completed:', {
          session_id: session.id,
          payment_status: session.payment_status,
          tier: session.metadata?.membership_tier,
          amount: `$${(session.amount_total / 100).toFixed(2)}`,
          email: session.customer_email,
          event_id: event.id
        });
        
        if (session.payment_status === 'paid') {
          console.log('🎯 Calling handleSuccessfulPayment for paid session...');
          const result = await handleSuccessfulPayment(session, event.id);
          console.log('📝 Payment processing completed with result:', result);
          
          // Log specifically about ledger insertion
          if (result.ledgerInserted) {
            console.log('✅ SUCCESS: Ledger record was inserted');
          } else {
            console.log('❌ FAILED: Ledger record was NOT inserted');
            console.log('🔍 Result details:', result);
          }
        } else {
          console.log(`ℹ️ Session ${session.id} not paid, status: ${session.payment_status}`);
        }
        break;
        
      case 'checkout.session.expired':
        console.log(`❌ Checkout session expired: ${event.data.object.id}`);
        break;
        
      case 'payment_intent.succeeded':
        console.log('💳 Payment intent succeeded:', event.data.object.id);
        break;
        
      default:
        console.log(`⚙️ Unhandled event type: ${event.type}`);
    }

    console.log('✅ Webhook processing completed for event:', event.id);
    
  } catch (err) {
    console.error('❌ Webhook processor error:', err);
    console.error('❌ Error details:', {
      message: err.message,
      stack: err.stack,
      event_id: event.id
    });
  }
};

/* --------------------------- Get Tier Information --------------------------- */
const getTierInfo = async (req, res) => {
  try {
    const tiers = {
      'discount19': {
        name: "Discounted Membership",
        price: 19,
        credits: 49,
        entries: 1,
        requirements: ["Under 25 or Over 60", "Government ID", "Live Selfie", "Social Media Link"],
        features: [
          "Lifetime membership",
          "1 Skill Event entry", 
          "49 credits",
          "Access to all partner sites",
          "Referral code",
          "Dashboard access"
        ]
      },
      'basic': {
        name: "Basic Membership", 
        price: 49,
        credits: 49,
        entries: 1,
        features: [
          "Lifetime membership",
          "49 credits",
          "1 Skill Event entry", 
          "Access to all partner sites",
          "Referrals",
          "Dashboard basics"
        ]
      },
      'pro': {
        name: "Pro Membership",
        price: 99, 
        credits: 49,
        entries: 3,
        credit_multiplier: 1.5,
        features: [
          "Everything in Basic",
          "Priority challenge window (UI badge)",
          "Credit multiplier 1.5x",
          "3 Skill Event entries",
          "Pro Welcome Perk placeholder"
        ]
      },
      'elite': {
        name: "Elite Membership",
        price: 499,
        credits: 500, 
        entries: 10,
        credit_multiplier: 1.5,
        features: [
          "Everything in Pro",
          "10 Skill Event entries",
          "500 credits",
          "Elite-only prep access",
          "VIP Onboarding", 
          "Marketplace priority",
          "Elite Welcome Pack",
          "Credit refund on event end (250)"
        ]
      }
    };

    res.json({ success: true, tiers });
  } catch (error) {
    console.error('Get tier info error:', error);
    res.status(500).json({ error: 'Failed to fetch tier information' });
  }
};

/* --------------------------- Health Check --------------------------- */
const healthCheck = async (req, res) => {
  try {
    // Test database connection
    const { data: userCount, error: dbError } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    // Test Stripe connection
    await stripe.balance.retrieve();

    res.json({
      status: 'healthy',
      database: dbError ? 'disconnected' : 'connected',
      stripe: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};


// Add these at the end of your stripeController.js file:

/* --------------------------- Legacy/Placeholder Functions --------------------------- */
const getSessionStatus = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session) {
      return res.status(404).json({ success: false, error: "Session not found" });
    }

    return res.json({
      success: true,
      session: {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        customer_email: session.customer_email,
        amount_total: session.amount_total,
      }
    });

  } catch (err) {
    console.error("Session status error:", err);
    return res.status(500).json({ success: false, error: "Could not retrieve session" });
  }
};

const testManualPayment = async (req, res) => {
  try {
    const { email, tier } = req.body;
    
    if (!email || !tier) {
      return res.status(400).json({ error: 'Email and tier are required' });
    }

    // Simulate a successful payment session
    const mockSession = {
      id: 'test_session_' + Date.now(),
      metadata: {
        user_email: email,
        membership_tier: tier,
        product_type: 'crowbar_master'
      },
      customer_email: email,
      amount_total: tier === 'discount19' ? 1900 : 
                   tier === 'basic' ? 4900 :
                   tier === 'pro' ? 9900 : 49900,
      payment_status: 'paid'
    };

    await handleSuccessfulPayment(mockSession, 'test_event_id');
    
    res.json({ 
      success: true, 
      message: `Test payment processed for ${email} with ${tier} tier` 
    });
  } catch (error) {
    console.error('Test manual payment error:', error);
    res.status(500).json({ error: 'Test payment failed' });
  }
};

const getUserAccess = async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normEmail(email))
      .single();

    if (error) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        email: user.email,
        membership_tier: user.membership_tier,
        total_credits: user.total_credits,
        entries_available: user.entries_available,
        membership_activated_at: user.membership_activated_at,
        kyc_status: user.kyc_status
      }
    });
  } catch (error) {
    console.error('Get user access error:', error);
    res.status(500).json({ error: 'Failed to get user access' });
  }
};

const syncUserAccess = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // This would typically sync user access across systems
    // For now, just return current user data
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', normEmail(email))
      .single();

    if (error) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      message: `User access synced for ${email}`,
      user: {
        email: user.email,
        membership_tier: user.membership_tier,
        total_credits: user.total_credits,
        entries_available: user.entries_available
      }
    });
  } catch (error) {
    console.error('Sync user access error:', error);
    res.status(500).json({ error: 'Failed to sync user access' });
  }
};
module.exports = {
  createCheckoutSession,
  handleWebhook,
  handleSuccessfulPayment,
  getTierInfo,
  healthCheck,
  applyAgeDiscount,
  uploadFile,
  getSessionStatus,
  testManualPayment,
  getUserAccess,
  syncUserAccess
};