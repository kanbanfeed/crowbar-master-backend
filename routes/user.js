app.post('/api/user/update-profile', async (req, res) => {
  try {
    const {
      email,
      full_name,
      phone,
      dob,
      address,
      id_doc_url,
      selfie_url,
      social_url
    } = req.body;

    if (!email) return res.status(400).json({ error: "Email is required" });

    const { data, error } = await supabase
      .from("users")
      .update({
        full_name,
        phone,
        dob,
        address,
        id_doc_url,
        selfie_url,
        social_url,
        kyc_status: 'pending'
      })
      .eq("email", email)
      .select();

    if (error) throw error;

    return res.json({ success: true, user: data[0] });

  } catch (err) {
    console.error("Profile update error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});
