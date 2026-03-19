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
      return res.status(422).json({ error: 'CV appears to be empty or unreadable.' });
    }

    const analysis = await analyzeCV(cvText);

    // Clean up file after analysis
    fs.unlinkSync(filePath);
    sessions.delete(invoiceId);

    return res.json({ success: true, analysis });
  } catch (error) {
    console.error('Error analyzing CV:', error);

    if (error.status === 401 || error.message?.includes('API key')) {
      return res.status(500).json({ error: 'Server authentication error. Please contact support.' });
    }
    if (error.status === 429) {
      return res.status(500).json({ error: 'Service temporarily unavailable. Please try again.' });
    }

    return res.status(500).json({ error: 'An error occurred while analyzing your CV.' });
  }
});

function buildPrompt(cvText) {
  return `You are an expert CV/Resume reviewer. Analyze the following CV and provide constructive feedback in valid JSON format.

Return ONLY a valid JSON object with these exact fields (no markdown, no code fences):
{
  "score": <integer 0-100>,
  "strengths": [<array of 3-5 specific strengths>],
  "weaknesses": [<array of 3-5 specific weaknesses>],
  "improvement_tips": [<array of 3-5 actionable, specific improvement tips>],
  "job_roles": [<array of at least 3 suggested job roles>]
}

Scoring rubric:
- 80-100: Excellent CV with strong experience, clear achievements, and tailored presentation
- 60-79: Good CV with solid experience but needs improvements in clarity or presentation
- 40-59: Fair CV with potential but significant gaps in experience, clarity, or structure
- 0-39: Needs major work - missing key information, poor organization, or unclear writing

Rules:
- Strengths must be specific, concrete observations about the CV
- Weaknesses must be specific areas for improvement
- Tips must be actionable and specific (not generic)
- Include at least 3 realistic job roles based on the CV content

CV to review:
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
