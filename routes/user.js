// routes/users.js
const express = require('express');
const { supabase } = require('../config/supabase');

const router = express.Router();

/**
 * POST /api/user/update-profile
 * Updates user profile + triggers reward if full profile + full KYC is complete.
 */
router.post('/user/update-profile', async (req, res) => {
  try {
    const {
      email,
      full_name,
      phone,
      dob,
      address,
      id_doc_url,
      selfie_url,
      social_url,
      id_front_url,
      id_back_url,
      dob_doc_url
    } = req.body || {};

    if (!email) {
      return res
        .status(400)
        .json({ success: false, error: 'Email is required' });
    }

    // 1️⃣ Update profile row
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({
        full_name: full_name ?? null,
        phone: phone ?? null,
        dob: dob ?? null,
        address: address ?? null,
        id_doc_url: id_doc_url ?? null,
        selfie_url: selfie_url ?? null,
        social_url: social_url ?? null,
        id_front_url: id_front_url ?? null,
        id_back_url: id_back_url ?? null,
        dob_doc_url: dob_doc_url ?? null
      })
      .eq('email', email.toLowerCase())
      .select()
      .single();

    if (updateError) {
      console.error('Profile update error:', updateError);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to update profile' });
    }

    if (!updatedUser) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // 2️⃣ CHECK required fields for reward
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

    // 3️⃣ REWARD 20 CREDITS
    if (profileComplete && kycComplete && !alreadyRewarded) {
      const newCredits = (updatedUser.total_credits || 0) + 20;

      await supabase
        .from('users')
        .update({
          total_credits: newCredits,
          profile_completed: true,
          kyc_status: 'pending'
        })
        .eq('email', email.toLowerCase());

      // Optionally record transaction
      await supabase.from('credits_ledger').insert({
        user_id: updatedUser.id,
        reason: 'reward',
        delta: 20,
        origin_site: 'Profile + KYC bonus'
      });

      console.log(`🎉 20 credits awarded to ${email}`);
    }

    return res.json({ success: true, user: updatedUser });

  } catch (err) {
    console.error('Profile update exception:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
