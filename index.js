const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));

// In-memory image store (auto-cleanup after 1h)
const imageStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of imageStore) {
    if (now - data.created > 3600000) imageStore.delete(id);
  }
}, 300000); // cleanup every 5 min

let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
    });
  }
  return browser;
}

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'html2img' }));

// Serve stored images by ID
app.get('/img/:id', (req, res) => {
  const data = imageStore.get(req.params.id);
  if (!data) return res.status(404).json({ error: 'Image expired or not found' });
  res.set('Content-Type', 'image/png');
  res.send(data.buffer);
});

// === SINGLE SCREENSHOT → returns URL ===
app.post('/screenshot', async (req, res) => {
  const { html, width = 1080, height = 1920 } = req.body;
  if (!html) return res.status(400).json({ error: 'Missing html' });
  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setViewport({ width, height });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const png = await page.screenshot({ type: 'png', fullPage: false });
    await page.close();

    const id = crypto.randomBytes(12).toString('hex');
    imageStore.set(id, { buffer: png, created: Date.now() });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${baseUrl}/img/${id}` });
  } catch (err) {
    console.error('Screenshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === BATCH: all slides of 1 post → returns URLs ===
// POST /batch { slides_html: ["<body1>", ...], css: "...", width: 1080, height: 1920 }
// Returns: { urls: ["https://.../img/abc", ...], count: 7 }
app.post('/batch', async (req, res) => {
  const { slides_html, css = '', width = 1080, height = 1920 } = req.body;
  if (!slides_html || !Array.isArray(slides_html)) {
    return res.status(400).json({ error: 'Missing slides_html array' });
  }
  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setViewport({ width, height });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const urls = [];

    for (const slideBody of slides_html) {
      const fullHtml = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Playfair+Display:ital,wght@0,700;1,700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${css}</style>
</head><body>${slideBody}</body></html>`;

      await page.setContent(fullHtml, { waitUntil: 'networkidle0', timeout: 10000 });
      const png = await page.screenshot({ type: 'png', fullPage: false });
      const id = crypto.randomBytes(12).toString('hex');
      imageStore.set(id, { buffer: png, created: Date.now() });
      urls.push(`${baseUrl}/img/${id}`);
    }
    await page.close();
    res.json({ urls, count: urls.length });
  } catch (err) {
    console.error('Batch error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`html2img running on :${PORT}`));
