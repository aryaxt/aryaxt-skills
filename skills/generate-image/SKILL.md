---
name: generate-image
description: Generate AI photos using the project's Gemini API and save them to the repo. Use when you need landing page images, marketing assets, placeholder photos, or any image for the project.
---

# Generate Image Skill

Generate photos using Google Gemini's image generation API directly from the CLI. Use this when you need images for landing pages, marketing, placeholders, or testing.

## Prerequisites

- `GEMINI_API_KEY` must be set in `.env.local`
- The `@google/genai` package is already installed

## CRITICAL: Loading the API Key

**The `.env.local` file is NOT automatically loaded by Node.js.** You MUST export it before running the script:

```bash
export $(grep GEMINI_API_KEY .env.local) && node -e "..."
```

**DO NOT** use `source .env.local` — it doesn't work reliably with the `=` format.
**DO NOT** rely on `process.env.GEMINI_API_KEY` being set automatically.

## How to Generate

### Single image

```bash
export $(grep GEMINI_API_KEY .env.local) && node -e "
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

(async () => {
  const prompt = 'YOUR_PROMPT_HERE';
  const outputPath = 'public/landing/YOUR_FILENAME.jpg';

  console.log('Generating:', prompt);

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: [{ text: prompt }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  const imagePart = parts?.find(p => p.inlineData);
  if (!imagePart?.inlineData?.data) {
    console.error('No image generated');
    process.exit(1);
  }

  fs.writeFileSync(outputPath, Buffer.from(imagePart.inlineData.data, 'base64'));
  console.log('Saved to:', outputPath);
})();
" 2>&1
```

### Batch generate multiple images

```bash
export $(grep GEMINI_API_KEY .env.local) && node -e "
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const images = [
  { prompt: 'Young woman hiking on a mountain trail, athletic outfit, golden hour, adventurous, photorealistic', output: 'public/landing/gallery-hiking-w.jpg' },
  { prompt: 'Young man cooking in a modern kitchen, casual outfit, warm lighting, lifestyle, photorealistic', output: 'public/landing/gallery-cooking.jpg' },
];

(async () => {
  for (const img of images) {
    console.log('Generating:', img.output);
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [{ text: img.prompt }],
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });
      const parts = response.candidates?.[0]?.content?.parts;
      const imagePart = parts?.find(p => p.inlineData);
      if (imagePart?.inlineData?.data) {
        fs.writeFileSync(img.output, Buffer.from(imagePart.inlineData.data, 'base64'));
        console.log('Saved:', img.output);
      } else {
        console.error('No image for:', img.output);
      }
    } catch (err) {
      console.error('Failed:', img.output, err.message);
    }
  }
  console.log('Done!');
})();
" 2>&1
```

### Generate with reference image (same person consistency)

```bash
export $(grep GEMINI_API_KEY .env.local) && node -e "
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

(async () => {
  const refImage = fs.readFileSync('public/landing/gallery-beach.jpg');
  const refBase64 = refImage.toString('base64');

  const prompt = 'Generate a new photo of this exact person at a ski resort, wearing ski gear, snowy mountains behind, bright winter lighting';
  const outputPath = 'public/landing/gallery-skiing.jpg';

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: [
      { inlineData: { data: refBase64, mimeType: 'image/jpeg' } },
      { text: prompt },
    ],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  const imagePart = parts?.find(p => p.inlineData);
  if (imagePart?.inlineData?.data) {
    fs.writeFileSync(outputPath, Buffer.from(imagePart.inlineData.data, 'base64'));
    console.log('Saved to:', outputPath);
  } else {
    console.error('No image generated');
  }
})();
" 2>&1
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `API key should be set` | `.env.local` not loaded | Use `export $(grep GEMINI_API_KEY .env.local) &&` before the node command |
| `PERMISSION_DENIED` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | Same as above — key not loaded, falls back to default credentials | Same fix — export the key explicitly |
| `No image generated` | Model returned text only, prompt may be too vague | Make prompt more specific, add "photorealistic" |
| `Request timeout` | Image generation can take 10-30s | Add `--max-old-space-size=4096` if needed, or increase Bash timeout |

## Tips for Good Prompts

- Always include: lighting description, camera style, mood
- For dating photos: "photorealistic, dating profile style, natural expression, approachable"
- For before photos: "low quality, amateur, bad lighting, unflattering" — ALWAYS add "no text or watermarks or dates on the image" or Gemini may add fake timestamps
- For diversity: alternate between men and women, different ethnicities
- For consistency: pass a reference image from an existing photo
- Specify framing: "portrait orientation", "head and shoulders", "full body"
- Always end with "photorealistic" for best results

## Where Images Live

- Landing page: `public/landing/`
- Gallery examples: `public/landing/gallery-*.jpg`
- Before/after pairs: `public/landing/before-*.jpg` and `public/landing/after-*.jpg`
- Women's variants use `-w` suffix: `gallery-beach-w.jpg`, `gallery-hiking-w.jpg`

## Cost

~$0.04 per image (Gemini 2.5 Flash Image pricing).

## Timeout

Set Bash timeout to at least 120000ms (2 min) for batch generation. Each image takes 10-30 seconds.
