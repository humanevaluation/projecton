# CV Reviewer

An AI-powered CV reviewer built with Claude Haiku that analyzes PDFs and provides structured feedback on strengths, weaknesses, improvement tips, and suggested job roles.

## Features

- 📄 **PDF Upload** — Drag-and-drop or click to upload CV files (max 10 MB)
- 🤖 **AI Analysis** — Uses Claude Haiku to provide intelligent, actionable feedback
- 🎯 **Structured Review** — Score (0–100), strengths, weaknesses, improvement tips, and job role suggestions
- 📊 **Visual Score Gauge** — Animated gauge with color-coded feedback (red <50, amber ≥50, green ≥70)
- 🎨 **Responsive Design** — Works on desktop and mobile devices
- ⚡ **Fast Processing** — Quick feedback on CV quality

## Tech Stack

- **Frontend:** HTML5, CSS3, Vanilla JavaScript
- **Backend:** Node.js, Express
- **AI:** Claude Haiku via Anthropic SDK
- **PDF Processing:** pdf-parse
- **File Handling:** Multer

## Prerequisites

- Node.js 18+ and npm
- Anthropic API key (get one at https://console.anthropic.com)

## Setup Instructions

1. **Clone or download this repository**
   ```bash
   cd cv-reviewer
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and add your Anthropic API key:
   ```
   ANTHROPIC_API_KEY=your_actual_api_key_here
   PORT=3000
   ```

4. **Start the server**
   ```bash
   npm start
   ```
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

5. **Open in browser**
   Navigate to `http://localhost:3000`

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude access | Yes |
| `PORT` | Server port (defaults to 3000) | No |

## API Reference

### POST `/api/review`

Analyzes a CV and returns structured feedback.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Field: `cv` (File) — PDF file to analyze

**Response (Success 200):**
```json
{
  "success": true,
  "analysis": {
    "score": 75,
    "strengths": ["Clear project descriptions", "..."],
    "weaknesses": ["Missing metrics", "..."],
    "improvement_tips": ["Add quantified achievements", "..."],
    "job_roles": ["Senior Developer", "Tech Lead", "Engineering Manager"]
  }
}
```

**Response (Error):**
| Status | Error | Meaning |
|--------|-------|---------|
| 400 | "Only PDF files are supported" | Non-PDF file uploaded |
| 413 | "File is too large" | File exceeds 10 MB limit |
| 422 | "CV appears to be empty" | PDF has no readable text |
| 500 | "An error occurred" | Server error |

## Project Structure

```
cv-reviewer/
├── index.html          # Frontend UI (HTML + CSS + JS)
├── server.js           # Express backend
├── package.json        # Dependencies and scripts
├── .gitignore          # Git ignore rules
├── .env                # Environment variables (not committed)
├── .env.example        # Example environment file
├── README.md           # This file
└── uploads/            # Temporary upload directory (auto-created, gitignored)
```

## How It Works

1. User uploads a PDF CV
2. Server validates the file (PDF only, max 10 MB)
3. PDF text is extracted using pdf-parse
4. Text is sent to Claude Haiku with a detailed prompt
5. Claude returns structured JSON feedback
6. Frontend displays results with animated score gauge and feedback cards
7. Temporary file is deleted after processing

## Scoring Rubric

- **80–100:** Excellent CV with strong experience, clear achievements, and tailored presentation
- **60–79:** Good CV with solid experience but needs improvements in clarity or presentation
- **40–59:** Fair CV with potential but significant gaps in experience, clarity, or structure
- **0–39:** Needs major work — missing key information, poor organization, or unclear writing

## Error Handling

The app gracefully handles:
- Invalid file types (only PDFs allowed)
- File size limits (max 10 MB)
- Empty or unreadable PDFs
- API authentication errors
- Network errors

## Development

### Build and Run Locally
```bash
npm install
npm run dev
```

### Project Features
- **Multer Configuration:** Disk storage to `uploads/`, automatic cleanup
- **Express Static:** Frontend served from same origin (no CORS needed)
- **PDF Parsing:** Extracts text from PDFs for analysis
- **Validation:** Comprehensive validation of API responses and user input
- **Error Recovery:** Graceful error handling with helpful messages

## License

MIT

---

Built with Claude Haiku and ❤️ by Anthropic
