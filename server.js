import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

const XENDIT_API_KEY = process.env.XENDIT_API_KEY;
const REVIEW_PRICE = 20000;

// Store: invoiceId -> { filePath, status, paidAt }
const sessions = new Map();

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    file.mimetype === 'application/pdf'
      ? cb(null, true)
      : cb(new Error('Only PDF files are allowed'), false);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.static(__dirname));

// POST /api/prepare - Upload CV + create invoice in one step
app.post('/api/prepare', upload.single('cv'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!XENDIT_API_KEY) {
      return res.status(500).json({ error: 'Payment service not configured' });
    }

    const invoiceId = `cv-review-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const successRedirectUrl = `${req.protocol}://${req.get('host')}/review.html?paid=${invoiceId}`;
    const failureRedirectUrl = `${req.protocol}://${req.get('host')}/review.html?paid=failed`;

    const response = await axios.post('https://api.xendit.co/v2/invoices', {
      external_id: invoiceId,
      amount: REVIEW_PRICE,
      description: 'CV Review',
      invoice_duration: 3600,
      success_redirect_url: successRedirectUrl,
      failure_redirect_url: failureRedirectUrl,
      currency: 'IDR'
    }, {
      auth: { username: XENDIT_API_KEY, password: '' }
    });

    // Store session with file path
    sessions.set(invoiceId, {
      filePath,
      status: 'pending',
      createdAt: new Date()
    });

    return res.json({
      success: true,
      invoiceId,
      invoiceUrl: response.data.invoice_url
    });
  } catch (error) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('Error preparing review:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to create payment. Please try again.' });
  }
});

// POST /api/webhook/xendit
app.post('/api/webhook/xendit', (req, res) => {
  const { external_id, status } = req.body;
  if (status === 'PAID' && sessions.has(external_id)) {
    sessions.get(external_id).status = 'paid';
  }
  return res.json({ status: 'ok' });
});

// POST /api/review - Analyze after payment (no file needed, uses stored file)
app.post('/api/review', async (req, res) => {
  const { invoiceId } = req.body;

  if (!invoiceId) {
    return res.status(400).json({ error: 'Missing invoiceId' });
  }

  let session = sessions.get(invoiceId);

  // Verify payment from Xendit API if not yet marked paid
  if (!session || session.status !== 'paid') {
    try {
      const xenditRes = await axios.get(
        `https://api.xendit.co/v2/invoices?external_id=${invoiceId}`,
        { auth: { username: XENDIT_API_KEY, password: '' } }
      );
      const invoice = xenditRes.data?.data?.[0] || xenditRes.data?.[0];
      if (invoice && invoice.status === 'PAID') {
        if (session) {
          session.status = 'paid';
        } else {
          return res.status(404).json({ error: 'Session not found. Please start over.' });
        }
      } else {
        return res.status(402).json({ error: 'Payment not completed yet.' });
      }
    } catch (err) {
      console.error('Xendit verification error:', err.response?.data || err.message);
      return res.status(500).json({ error: 'Could not verify payment. Please try again.' });
    }
  }

  const { filePath } = session;

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'CV file not found. Please start over.' });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(fileBuffer);
    const cvText = pdfData.text;

    if (!cvText || cvText.trim().length < 50) {
      return res.status(422).json({ error: 'CV tidak bisa dibaca. Pastikan PDF mengandung teks dan coba lagi.' });
    }

    const analysis = await analyzeCV(cvText);

    fs.unlinkSync(filePath);
    sessions.delete(invoiceId);

    return res.json({ success: true, analysis });
  } catch (error) {
    console.error('Error analyzing CV:', error.message || error);

    if (error.status === 401 || error.message?.includes('API key') || error.message?.includes('authentication')) {
      return res.status(500).json({ error: 'API key tidak valid. Hubungi admin.' });
    }
    if (error.status === 429) {
      return res.status(500).json({ error: 'Server sedang sibuk. Coba lagi dalam beberapa detik.' });
    }
    if (error.message?.includes('JSON') || error.message?.includes('parse')) {
      return res.status(500).json({ error: 'Gagal memproses hasil analisis. Coba lagi.' });
    }

    return res.status(500).json({ error: error.message || 'Terjadi kesalahan saat menganalisis CV.' });
  }
});

function buildPrompt(cvText) {
  return `Kamu adalah reviewer CV profesional. Analisis CV berikut dan kembalikan hasil dalam format JSON yang valid. Semua teks feedback harus dalam Bahasa Indonesia.

PENTING: Kembalikan HANYA objek JSON murni, tanpa markdown, tanpa kode fences, tanpa teks lain apapun di luar JSON.

Format JSON yang harus dikembalikan:
{"score":75,"strengths":["contoh kelebihan spesifik"],"weaknesses":["contoh kekurangan spesifik"],"improvement_tips":["contoh tips perbaikan"],"job_roles":["contoh posisi kerja"]}

Aturan scoring:
- 80-100: CV sangat baik, pengalaman kuat, pencapaian jelas
- 60-79: CV bagus, perlu sedikit perbaikan
- 40-59: CV cukup, perlu perbaikan signifikan
- 0-39: CV perlu banyak perbaikan mendasar

Aturan penulisan feedback (WAJIB diikuti):
- Jika CV memiliki angka/data, sertakan angkanya. Contoh: "Meningkatkan engagement 30% dalam 3 bulan" bukan "Meningkatkan engagement"
- Jika tidak ada angka, sarankan untuk ditambahkan. Contoh: "Tambahkan angka pencapaian, misal: berhasil handle 50+ klien"
- Setiap poin harus spesifik merujuk pada isi CV, bukan generik
- Berikan minimal 3 dan maksimal 5 poin per kategori
- Job roles minimal 3 posisi yang sesuai dengan pengalaman di CV

CV untuk direview:
---
${cvText}
---`;
}

function validateAnalysis(data) {
  return (
    data &&
    typeof data.score === 'number' && data.score >= 0 && data.score <= 100 &&
    Array.isArray(data.strengths) && data.strengths.length > 0 &&
    Array.isArray(data.weaknesses) && data.weaknesses.length > 0 &&
    Array.isArray(data.improvement_tips) && data.improvement_tips.length > 0 &&
    Array.isArray(data.job_roles) && data.job_roles.length >= 3
  );
}

async function analyzeCV(cvText) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildPrompt(cvText) }]
  });

  let responseText = message.content[0].text
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  const analysis = JSON.parse(responseText);

  if (!validateAnalysis(analysis)) {
    throw new Error('Invalid analysis structure returned from Claude');
  }

  return analysis;
}

// Error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'FILE_TOO_LARGE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 10 MB.' });
  }
  if (err.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: 'Only PDF files are supported.' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CV Reviewer running on http://localhost:${PORT}`);
});
