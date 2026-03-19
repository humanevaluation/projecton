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

// Middleware
app.use(express.json());

// Xendit configuration
const XENDIT_API_KEY = process.env.XENDIT_API_KEY;
const REVIEW_PRICE = 20000; // Rp 20.000

// In-memory payment tracking (for production, use database)
const payments = new Map();
const pendingReviews = new Map();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    cb(null, `${timestamp}-${random}.pdf`);
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// Static files
app.use(express.static(__dirname));

// POST /api/create-invoice - Create Xendit invoice for CV review
app.post('/api/create-invoice', async (req, res) => {
  try {
    if (!XENDIT_API_KEY) {
      return res.status(500).json({ error: 'Payment service not configured' });
    }

    const invoiceId = `cv-review-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const successRedirectUrl = `${req.protocol}://${req.get('host')}/?paid=${invoiceId}`;
    const failureRedirectUrl = `${req.protocol}://${req.get('host')}/?paid=failed`;

    const invoiceData = {
      external_id: invoiceId,
      amount: REVIEW_PRICE,
      description: 'CV Review - Xendit',
      invoice_duration: 3600, // 1 hour expiry
      success_redirect_url: successRedirectUrl,
      failure_redirect_url: failureRedirectUrl,
      currency: 'IDR'
    };

    const response = await axios.post('https://api.xendit.co/v2/invoices', invoiceData, {
      auth: {
        username: XENDIT_API_KEY,
        password: ''
      }
    });

    // Store invoice info
    payments.set(invoiceId, {
      status: 'pending',
      amount: REVIEW_PRICE,
      createdAt: new Date(),
      invoiceUrl: response.data.invoice_url
    });

    return res.json({
      success: true,
      invoiceId,
      invoiceUrl: response.data.invoice_url,
      amount: REVIEW_PRICE
    });
  } catch (error) {
    console.error('Error creating invoice:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to create invoice. Please try again.' });
  }
});

// POST /api/webhook/xendit - Handle Xendit payment callback
app.post('/api/webhook/xendit', (req, res) => {
  try {
    const { external_id, status } = req.body;

    if (status === 'PAID') {
      if (payments.has(external_id)) {
        payments.set(external_id, {
          ...payments.get(external_id),
          status: 'paid',
          paidAt: new Date()
        });
      }
    }

    return res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error handling webhook:', error);
    return res.status(500).json({ error: 'Webhook error' });
  }
});

// GET /api/payment-status - Check if invoice is paid
app.get('/api/payment-status/:invoiceId', (req, res) => {
  const { invoiceId } = req.params;
  const payment = payments.get(invoiceId);

  if (!payment) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  return res.json({
    invoiceId,
    status: payment.status,
    isPaid: payment.status === 'paid'
  });
});

// Build prompt for Claude
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
- Be professional but constructive

CV to review:
---
${cvText}
---`;
}

// Validate analysis structure
function validateAnalysis(data) {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const hasScore = typeof data.score === 'number' && data.score >= 0 && data.score <= 100;
  const hasStrengths = Array.isArray(data.strengths) && data.strengths.length > 0;
  const hasWeaknesses = Array.isArray(data.weaknesses) && data.weaknesses.length > 0;
  const hasTips = Array.isArray(data.improvement_tips) && data.improvement_tips.length > 0;
  const hasRoles = Array.isArray(data.job_roles) && data.job_roles.length >= 3;

  return hasScore && hasStrengths && hasWeaknesses && hasTips && hasRoles;
}

// Analyze CV with Claude
async function analyzeCV(cvText) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const prompt = buildPrompt(cvText);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  // Extract text from response
  let responseText = message.content[0].text;

  // Remove markdown code fences if present
  responseText = responseText
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // Parse JSON
  const analysis = JSON.parse(responseText);

  // Validate structure
  if (!validateAnalysis(analysis)) {
    throw new Error('Invalid analysis structure returned from Claude');
  }

  return analysis;
}

// POST /api/review endpoint - Analyze CV after payment
app.post('/api/review', upload.single('cv'), async (req, res) => {
  const filePath = req.file?.path;
  const { invoiceId } = req.body;

  try {
    // Validate file was attached
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Check if payment is required and verified
    if (invoiceId && payments.has(invoiceId)) {
      const payment = payments.get(invoiceId);
      if (payment.status !== 'paid') {
        return res.status(402).json({ error: 'Payment not completed. Please complete payment first.' });
      }
      // Mark invoice as used
      payment.analyzed = true;
    }

    // Read and parse PDF
    const fileBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(fileBuffer);
    const cvText = pdfData.text;

    // Guard: check minimum text length
    if (!cvText || cvText.trim().length < 50) {
      return res.status(422).json({
        error: 'CV appears to be empty or unreadable. Please ensure the PDF contains text and try again.'
      });
    }

    // Analyze CV
    const analysis = await analyzeCV(cvText);

    return res.json({ success: true, analysis });
  } catch (error) {
    console.error('Error processing CV:', error);

    // Handle specific error types
    if (error.message.includes('Only PDF files are allowed')) {
      return res.status(400).json({ error: 'Only PDF files are supported. Please upload a PDF.' });
    }

    if (error.status === 401 || error.message.includes('API key')) {
      return res.status(500).json({ error: 'Server authentication error. Please contact support.' });
    }

    if (error.status === 429) {
      return res.status(500).json({ error: 'Service is temporarily unavailable. Please try again later.' });
    }

    return res.status(500).json({ error: 'An error occurred while analyzing your CV. Please try again.' });
  } finally {
    // Always delete temporary file
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

// Error handler for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({ error: 'File is too large. Maximum size is 10 MB.' });
    }
  }

  if (err.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: 'Only PDF files are supported. Please upload a PDF.' });
  }

  next(err);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CV Reviewer server running on http://localhost:${PORT}`);
});
