require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const heicConvert = require('heic-convert');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// File upload storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync('uploads', { recursive: true });
    cb(null, 'uploads');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const requireAuth = (req, res, next) => {
  if (req.session.authenticated) return next();
  if (req.headers.accept?.includes('application/json') || req.method === 'POST') {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/');
};

// ─── eBay Token Helpers ───────────────────────────────────────────────────────

const TOKENS_FILE = 'ebay_tokens.json';

function getTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return null; }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({ ...tokens, saved_at: Date.now() }));
}

async function getAccessToken() {
  const tokens = getTokens();
  if (!tokens) return null;

  const expiresAt = tokens.saved_at + (tokens.expires_in - 300) * 1000;
  if (Date.now() < expiresAt) return tokens.access_token;

  // Refresh expired token
  try {
    const res = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(tokens.refresh_token)}`,
      {
        auth: { username: process.env.EBAY_CLIENT_ID, password: process.env.EBAY_CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    saveTokens(res.data);
    return res.data.access_token;
  } catch (err) {
    console.error('Token refresh failed:', err.response?.data);
    return null;
  }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/login', (req, res) => {
  const { password } = req.body;
  const expected = process.env.APP_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'APP_PASSWORD not set' });

  try {
    const a = Buffer.from(password || '');
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      req.session.authenticated = true;
      return res.json({ ok: true });
    }
  } catch {}
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/app', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─── eBay OAuth ───────────────────────────────────────────────────────────────

app.get('/ebay/status', requireAuth, async (req, res) => {
  const token = await getAccessToken();
  res.json({ connected: !!token });
});

app.get('/ebay/connect', requireAuth, (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID,
    redirect_uri: process.env.EBAY_REDIRECT_URI,
    response_type: 'code',
    scope: [
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.account',
    ].join(' '),
    prompt: 'login',
  });
  res.redirect(`https://auth.ebay.com/oauth2/authorize?${params}`);
});

app.get('/ebay/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/app?ebay=error');

  try {
    const tokenRes = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(process.env.EBAY_REDIRECT_URI)}`,
      {
        auth: { username: process.env.EBAY_CLIENT_ID, password: process.env.EBAY_CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    saveTokens(tokenRes.data);
    res.redirect('/app?ebay=connected');
  } catch (err) {
    console.error('eBay OAuth error:', err.response?.data);
    res.redirect('/app?ebay=error');
  }
});

// ─── Generate Listing with Claude ─────────────────────────────────────────────

app.post('/generate', requireAuth, upload.array('photos', 10), async (req, res) => {
  const photos = req.files || [];

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const content = [];
    const { description, weight, size } = req.body;

    for (const photo of photos) {
      let imageBuffer = fs.readFileSync(photo.path);
      let mimeType = photo.mimetype || 'image/jpeg';

      // Convert HEIC/HEIF to JPEG (iPhone default format)
      const isHeic = mimeType === 'image/heic' || mimeType === 'image/heif'
        || photo.originalname.toLowerCase().endsWith('.heic')
        || photo.originalname.toLowerCase().endsWith('.heif');

      if (isHeic) {
        const converted = await heicConvert({ buffer: imageBuffer, format: 'JPEG', quality: 0.85 });
        imageBuffer = Buffer.from(converted);
        mimeType = 'image/jpeg';
      }

      // Resize to max 1024px — keeps quality good for AI analysis, shrinks file dramatically
      imageBuffer = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      mimeType = 'image/jpeg';

      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: imageBuffer.toString('base64'),
        }
      });
    }

    const shippingContext = [weight && `Weight: ${weight}`, size && `Size: ${size}`].filter(Boolean).join(', ');

    content.push({
      type: 'text',
      text: `You are an expert eBay seller with 20 years of experience maximizing sales.
Analyze ${photos.length > 0 ? 'these photos' : 'this description'} and create an optimized eBay listing.${description ? `\nSeller notes: ${description}` : ''}${shippingContext ? `\nShipping info: ${shippingContext}` : ''}

Use your knowledge to estimate the item's real-world weight and dimensions.

USPS flat rate prices (2024):
- Padded Flat Rate Envelope (12.5x9.5"): $10.45 — fits documents, small flat items under ~4 lbs
- Small Flat Rate Box (8.625x5.375x1.625"): $11.15 — small dense items
- Medium Flat Rate Box (11x8.5x5.5"): $17.10 — fits most shoe-box sized items
- Large Flat Rate Box (12x12x5.5"): $22.10 — large heavy items
USPS Ground Advantage typical rates: under 1lb ~$5, 1-2lb ~$8, 2-5lb ~$11, 5-10lb ~$14, 10-20lb ~$18

Determine: does this item fit in any flat rate option? If so, compare that flat rate price vs estimated Ground Advantage cost. Flat rate is "recommended" when it's cheaper OR when the item is heavy enough that flat rate saves money.

Respond with ONLY valid JSON — no markdown, no code blocks, nothing else:
{
  "title": "keyword-rich SEO title under 80 characters",
  "condition": "NEW" or "LIKE_NEW" or "USED_EXCELLENT" or "USED_GOOD" or "USED_ACCEPTABLE" or "FOR_PARTS",
  "conditionNote": "honest 1-sentence condition note",
  "price": <suggested price as a plain number>,
  "description": "compelling 3-paragraph description covering what it is, key features/specs, condition details and what's included",
  "categoryName": "specific eBay category (e.g. 'Vintage Cameras & Photo', 'Men's Coats & Jackets')",
  "shippingNote": "best non-flat-rate option with cost range, e.g. 'USPS Ground Advantage, approx $8–11'",
  "weightEstimate": one of exactly: "under 1 lb" or "1-2 lbs" or "2-5 lbs" or "5-10 lbs" or "10-20 lbs" or "over 20 lbs",
  "sizeEstimate": one of exactly: "fits in a shoebox" or "fits in a small flat rate box" or "fits in a medium flat rate box" or "large or bulky" or "furniture or freight",
  "dimensionsNote": "estimated dimensions and weight, e.g. '12 x 8 x 4 inches, approx 3 lbs'",
  "flatRateOption": name of the best fitting flat rate box/envelope, or null if item is too large,
  "flatRatePrice": flat rate price as a number (e.g. 17.10), or null,
  "flatRateRecommended": true if flat rate is cheaper or better value than ground, false otherwise,
  "flatRateReason": "one sentence why flat rate is or isn't recommended"
}`
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content }]
    });

    let listing;
    const text = response.content[0].text.trim();
    try {
      listing = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) listing = JSON.parse(match[0]);
      else throw new Error('Could not parse listing from Claude response');
    }

    listing.photoFiles = photos.map(p => p.filename);
    res.json(listing);

  } catch (err) {
    photos.forEach(p => { try { fs.unlinkSync(p.path); } catch {} });
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate listing' });
  }
});

// ─── Save Draft to eBay ───────────────────────────────────────────────────────

app.post('/save-draft', requireAuth, async (req, res) => {
  const { title, condition, conditionNote, price, description, photoFiles } = req.body;

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return res.status(401).json({ error: 'eBay not connected', needsConnect: true });
    }

    const sku = `DRAFTIT-${Date.now()}`;
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

    const conditionMap = {
      NEW: 'NEW',
      LIKE_NEW: 'LIKE_NEW',
      USED_EXCELLENT: 'USED_EXCELLENT',
      USED_GOOD: 'USED_GOOD',
      USED_ACCEPTABLE: 'USED_ACCEPTABLE',
      FOR_PARTS: 'FOR_PARTS_OR_NOT_WORKING',
    };

    const imageUrls = (photoFiles || [])
      .filter(f => f && fs.existsSync(path.join('uploads', f)))
      .map(f => `${appUrl}/uploads/${f}`);

    // Step 1: Create inventory item
    await axios.put(
      `https://api.ebay.com/sell/inventory/v1/inventory_item/${sku}`,
      {
        product: {
          title,
          description,
          ...(imageUrls.length > 0 && { imageUrls }),
        },
        condition: conditionMap[condition] || 'USED_GOOD',
        conditionDescription: conditionNote || '',
        availability: {
          shipToLocationAvailability: { quantity: 1 }
        }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    // Step 2: Create unpublished offer (= draft listing)
    const offerRes = await axios.post(
      'https://api.ebay.com/sell/inventory/v1/offer',
      {
        sku,
        marketplaceId: 'EBAY_US',
        format: 'FIXED_PRICE',
        pricingSummary: {
          price: { value: String(parseFloat(price) || 9.99), currency: 'USD' }
        },
        listingDescription: description,
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    res.json({ ok: true, sku, offerId: offerRes.data.offerId });

  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.longMessage
      || err.response?.data?.errors?.[0]?.message
      || err.message;
    console.error('Save draft error:', err.response?.data || err.message);
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => console.log(`DraftIt running on port ${PORT}`));
