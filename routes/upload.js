// routes/upload.js
const express = require('express');
const multer = require('multer');
const { supabase } = require('../config/supabase'); // adjust path if needed

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const folder = req.body.folder || 'kyc';
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, error: 'File missing' });
    }

    const filePath = `${folder}/${Date.now()}-${file.originalname}`;

    const { data: uploaded, error } = await supabase.storage
      .from('user_uploads')
      .upload(filePath, file.buffer, { contentType: file.mimetype });

    if (error) {
      console.error('Supabase upload error:', error);
      throw error;
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from('user_uploads').getPublicUrl(filePath);

    return res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
