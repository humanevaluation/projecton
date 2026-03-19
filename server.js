import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

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

// POST /api/review endpoint
app.post('/api/review', upload.single('cv'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    // Validate file was attached
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
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
