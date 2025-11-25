// routes/users.js
const express = require('express');
const { supabase } = require('../config/supabase');

const router = express.Router();

/**
 * POST /api/user/update-profile
 * Updates user profile + triggers reward if full profile + full KYC is complete.
 */
// routes/users.js - Add detailed logging
router.post('/user/update-profile', async (req, res) => {
  try {
    const {
      email,
      full_name,
      phone,
      dob,
      address,
      social_url,
      id_front_url,
      id_back_url,
      selfie_url,
      dob_doc_url
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    // 1️⃣ Update profile row
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({
        full_name: full_name ?? null,
        phone: phone ?? null,
        dob: dob ?? null,
        address: address ?? null,
        social_url: social_url ?? null,
        id_front_url: id_front_url ?? null,
        id_back_url: id_back_url ?? null,
        selfie_url: selfie_url ?? null,
        dob_doc_url: dob_doc_url ?? null
      })
      .eq('email', email.toLowerCase())
      .select()
      .single();

    if (updateError) {
      console.error('Profile update error:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to update profile' });
    }

    if (!updatedUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    console.log("🟦 FULL UPDATED USER ROW:", updatedUser);

    // 2️⃣ CHECK required fields for reward - ADD DEBUG LOGGING
    const profileComplete =
      updatedUser.full_name &&
      updatedUser.phone &&
      updatedUser.dob &&
      updatedUser.address &&
      updatedUser.social_url;

    const kycComplete =
      updatedUser.id_front_url &&
      updatedUser.id_back_url &&
      updatedUser.selfie_url &&
      updatedUser.dob_doc_url;

    // Already rewarded?
    const alreadyRewarded = updatedUser.profile_completed === true;

    // 🔍 DEBUG LOGGING
    console.log('=== CREDIT REWARD DEBUG ===');
    console.log('User:', email);
    console.log('Profile Complete:', profileComplete, {
      name: !!updatedUser.full_name,
      phone: !!updatedUser.phone,
      dob: !!updatedUser.dob,
      address: !!updatedUser.address,
      social_url: !!updatedUser.social_url
    });
    console.log('KYC Complete:', kycComplete, {
      id_front: !!updatedUser.id_front_url,
      id_back: !!updatedUser.id_back_url,
      selfie: !!updatedUser.selfie_url,
      dob_doc: !!updatedUser.dob_doc_url
    });
    console.log('Already Rewarded:', alreadyRewarded);
    console.log('Should Reward:', profileComplete && kycComplete && !alreadyRewarded);

    // 3️⃣ REWARD 20 CREDITS
 /* ---------------- CREDIT REWARD PROCESSOR ---------------- */
/* ---------------- CREDIT REWARD PROCESSOR ---------------- */
if (profileComplete && kycComplete && !alreadyRewarded) {
  console.log('🎉 AWARDING 20 CREDITS TO:', email);

  const newCredits = (updatedUser.total_credits || 0) + 20;

  // ✅ Correct primary key based on your DB structure
  const userId = updatedUser.id;
  console.log("🆔 Using correct userId:", userId);

  // 1️⃣ Update users table
  const { error: creditError } = await supabase
    .from('users')
    .update({
      total_credits: newCredits,
      profile_completed: true,
      kyc_status: 'pending'
    })
    .eq('email', email.toLowerCase());

  if (creditError) {
    console.error('Credit update error:', creditError);
  } else {

    // 2️⃣ INSERT into credits_ledger
    const { error: ledgerError } = await supabase
  .from('credits_ledger')
  .insert({
    email: updatedUser.email,              // REQUIRED FIELD
    delta: 20,
    reason: 'reward',
    origin_site: 'Profile + KYC bonus',
    reward_day: new Date().toISOString().slice(0, 10)
  });

if (ledgerError) {
  console.error("❌ FULL LEDGER INSERT ERROR:", JSON.stringify(ledgerError, null, 2));
} else {
  console.log("✅ SUCCESS: Ledger record inserted");
}

    // 3️⃣ UPDATE credits table
    const { error: balanceError } = await supabase
      .from('credits')
      .upsert({
        user_id: userId,
        balance: newCredits
      });

    if (balanceError) {
      console.log("❌ FAILED updating credits table:", balanceError);
    } else {
      console.log("✅ SUCCESS: Credits table updated");
    }
  }
}


    return res.json({ success: true, user: updatedUser });

  } catch (err) {
    console.error('Profile update exception:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;