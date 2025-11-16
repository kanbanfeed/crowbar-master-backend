import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload', upload.single("file"), async (req, res) => {
  try {
    const folder = req.body.folder || "kyc";
    const file = req.file;

    if (!file) return res.status(400).json({ error: "File missing" });

    const filePath = `${folder}/${Date.now()}-${file.originalname}`;

    const { data: uploaded, error } = await supabase.storage
      .from("user_uploads")
      .upload(filePath, file.buffer, { contentType: file.mimetype });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from("user_uploads")
      .getPublicUrl(filePath);

    return res.json({ success: true, url: publicUrl });

  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
