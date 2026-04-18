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
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── eBay Environment (sandbox vs production) ────────────────────────────────
const EBAY_ENV = (process.env.EBAY_ENV || 'production').toLowerCase();
const EBAY_URLS = EBAY_ENV === 'sandbox' ? {
  api: 'https://api.sandbox.ebay.com',
  auth: 'https://auth.sandbox.ebay.com',
  finding: 'https://svcs.sandbox.ebay.com',
} : {
  api: 'https://api.ebay.com',
  auth: 'https://auth.ebay.com',
  finding: 'https://svcs.ebay.com',
};
console.log(`eBay environment: ${EBAY_ENV}`);

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

// Hostname routing: thelazz.com serves the bracket at root
app.use((req, res, next) => {
  const host = (req.hostname || '').replace(/^www\./, '');
  if (host === 'thelazz.com') {
    // Serve lazz/ subfolder as the root for this domain
    return express.static(path.join(__dirname, 'public', 'lazz'))(req, res, next);
  }
  next();
});
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

// ─── Lazz Bracket — Google Sheets API ─────────────────────────────────────────

const LAZZ_SHEET_ID = process.env.LAZZ_SHEET_ID || '1-18DEo78ttbH_-hVmNC-vuq_PW62qJ6Dv3Zogc2eWh8';

function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// GET /lazz/api/health — diagnostic check for Sheets connection
app.get('/lazz/api/health', async (req, res) => {
  const hasEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!hasEnv) return res.json({ ok: false, error: 'GOOGLE_SERVICE_ACCOUNT_JSON env var not set' });
  try {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!parsed.client_email) return res.json({ ok: false, error: 'JSON missing client_email', keys: Object.keys(parsed) });
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: LAZZ_SHEET_ID,
      range: 'A1:F1',
    });
    res.json({ ok: true, headers: result.data.values?.[0], sheetId: LAZZ_SHEET_ID, email: parsed.client_email });
  } catch (err) {
    res.json({ ok: false, error: err.message, details: err.response?.data?.error });
  }
});

// POST /lazz/api/update-winner — admin sets a match winner
app.post('/lazz/api/update-winner', async (req, res) => {
  const { matchId, winner, password } = req.body;
  // Simple auth check (same password as the client-side admin)
  if (password !== (process.env.LAZZ_ADMIN_PASSWORD || 'mttam')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!matchId || !winner) {
    return res.status(400).json({ error: 'matchId and winner required' });
  }
  // Match IDs are M1–M31, stored in rows 34–64, column D (winner) and E (score)
  const matchNum = parseInt(matchId.replace('M', ''), 10);
  if (isNaN(matchNum) || matchNum < 1 || matchNum > 31) {
    return res.status(400).json({ error: 'Invalid matchId (M1–M31)' });
  }
  const row = 33 + matchNum; // M1 → row 34, M2 → row 35, etc.
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: LAZZ_SHEET_ID,
      range: `D${row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[winner]] },
    });
    console.log(`[Lazz] Updated ${matchId} → ${winner} (row ${row})`);
    res.json({ ok: true, matchId, winner, row });
  } catch (err) {
    console.error('Sheets API error:', err.message, err.response?.data?.error);
    res.status(500).json({ error: 'Failed to update sheet: ' + err.message });
  }
});

// POST /lazz/api/clear-winner — admin clears a match winner
app.post('/lazz/api/clear-winner', async (req, res) => {
  const { matchId, password } = req.body;
  if (password !== (process.env.LAZZ_ADMIN_PASSWORD || 'mttam')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const matchNum = parseInt((matchId || '').replace('M', ''), 10);
  if (isNaN(matchNum) || matchNum < 1 || matchNum > 31) {
    return res.status(400).json({ error: 'Invalid matchId (M1–M31)' });
  }
  const row = 33 + matchNum;
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: LAZZ_SHEET_ID,
      range: `D${row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
    console.log(`[Lazz] Cleared ${matchId} (row ${row})`);
    res.json({ ok: true, matchId, row });
  } catch (err) {
    console.error('Sheets API error:', err.message, err.response?.data?.error);
    res.status(500).json({ error: 'Failed to clear winner: ' + err.message });
  }
});

// POST /lazz/api/update-schedule — admin sets a match date/time
app.post('/lazz/api/update-schedule', async (req, res) => {
  const { matchId, schedule, password } = req.body;
  if (password !== (process.env.LAZZ_ADMIN_PASSWORD || 'mttam')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const matchNum = parseInt((matchId || '').replace('M', ''), 10);
  if (isNaN(matchNum) || matchNum < 1 || matchNum > 31) {
    return res.status(400).json({ error: 'Invalid matchId (M1–M31)' });
  }
  const row = 33 + matchNum;
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: LAZZ_SHEET_ID,
      range: `F${row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[schedule || '']] },
    });
    console.log(`[Lazz] Schedule ${matchId} → "${schedule}" (row ${row})`);
    res.json({ ok: true, matchId, schedule, row });
  } catch (err) {
    console.error('Sheets API error:', err.message, err.response?.data?.error);
    res.status(500).json({ error: 'Failed to update schedule: ' + err.message });
  }
});

// ─── eBay Sold Listings Search ────────────────────────────────────────────────

async function searchSoldListings(query, limit = 20) {
  const clientId = process.env.EBAY_CLIENT_ID;
  if (!clientId) return null;

  try {
    // Use eBay Finding API — findCompletedItems (sold listings)
    const params = new URLSearchParams({
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.13.0',
      'SECURITY-APPNAME': clientId,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'REST-PAYLOAD': '',
      'keywords': query,
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'itemFilter(1).name': 'ListingType',
      'itemFilter(1).value(0)': 'FixedPrice',
      'itemFilter(1).value(1)': 'AuctionWithBIN',
      'itemFilter(1).value(2)': 'Auction',
      'sortOrder': 'EndTimeSoonest',
      'paginationInput.entriesPerPage': String(limit),
    });

    const res = await axios.get(
      `${EBAY_URLS.finding}/services/search/FindingService/v1?${params}`
    );

    const root = res.data?.findCompletedItemsResponse?.[0];
    if (!root || root.ack?.[0] !== 'Success') return null;

    const items = root.searchResult?.[0]?.item || [];
    return items.map(item => ({
      title: item.title?.[0] || '',
      price: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0),
      shippingCost: parseFloat(item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.__value__ || 0),
      totalPrice: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0)
                + parseFloat(item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.__value__ || 0),
      condition: item.condition?.[0]?.conditionDisplayName?.[0] || '',
      listingType: item.listingInfo?.[0]?.listingType?.[0] || '',
      endDate: item.listingInfo?.[0]?.endTime?.[0] || '',
      url: item.viewItemURL?.[0] || '',
      imageUrl: item.galleryURL?.[0] || '',
    }));
  } catch (err) {
    console.error('eBay sold search error:', err.message);
    return null;
  }
}

function computeMarketStats(soldItems) {
  if (!soldItems || !soldItems.length) return null;

  const prices = soldItems.map(i => i.totalPrice).sort((a, b) => a - b);
  const itemPrices = soldItems.map(i => i.price).sort((a, b) => a - b);

  const sum = prices.reduce((a, b) => a + b, 0);
  const avg = sum / prices.length;
  const median = prices.length % 2 === 0
    ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : prices[Math.floor(prices.length / 2)];

  // Low BIN = lowest fixed-price sold item (total with shipping)
  const fixedPriceItems = soldItems.filter(i => i.listingType === 'FixedPrice' || i.listingType === 'AuctionWithBIN');
  const lowBin = fixedPriceItems.length
    ? Math.min(...fixedPriceItems.map(i => i.totalPrice))
    : prices[0];

  return {
    count: prices.length,
    low: prices[0],
    high: prices[prices.length - 1],
    average: Math.round(avg * 100) / 100,
    median: Math.round(median * 100) / 100,
    lowBuyItNow: Math.round(lowBin * 100) / 100,
    priceRange: { low: prices[0], mid: Math.round(avg * 100) / 100, high: prices[prices.length - 1] },
    recentSales: soldItems.slice(0, 8).map(i => ({
      title: i.title,
      price: i.price,
      shippingCost: i.shippingCost,
      totalPrice: i.totalPrice,
      condition: i.condition,
      listingType: i.listingType,
      endDate: i.endDate,
      url: i.url,
      imageUrl: i.imageUrl,
    })),
  };
}

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
      `${EBAY_URLS.api}/identity/v1/oauth2/token`,
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
  res.redirect(`${EBAY_URLS.auth}/oauth2/authorize?${params}`);
});

app.get('/ebay/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/app?ebay=error');

  try {
    const tokenRes = await axios.post(
      `${EBAY_URLS.api}/identity/v1/oauth2/token`,
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
    const { description, weight, size, freeShipping } = req.body;
    const isFreeShipping = freeShipping === 'true' || freeShipping === true;

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

    const shippingContext = [
      weight && `Weight: ${weight}`,
      size && `Size: ${size}`,
      isFreeShipping && 'Seller wants to offer FREE SHIPPING (build shipping cost into item price)',
    ].filter(Boolean).join(', ');

    // First pass: quick identification for eBay search
    const idContent = [...content, {
      type: 'text',
      text: `Identify this item briefly. Respond with ONLY valid JSON:
{"searchQuery": "optimized eBay search keywords for finding comparable sold listings"}`
    }];

    let marketContext = '';
    let marketStats = null;
    try {
      const idRes = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: idContent }]
      });
      const idText = idRes.content[0].text.trim();
      let parsed;
      try { parsed = JSON.parse(idText); } catch { const m = idText.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); }

      if (parsed?.searchQuery) {
        const soldItems = await searchSoldListings(parsed.searchQuery);
        marketStats = computeMarketStats(soldItems);
        if (marketStats) {
          marketContext = `\n\nMARKET DATA from recent eBay sold listings for "${parsed.searchQuery}":
- ${marketStats.count} recent sales found
- Price range: $${marketStats.low.toFixed(2)} – $${marketStats.high.toFixed(2)} (including shipping)
- Average sold price: $${marketStats.average.toFixed(2)}
- Median sold price: $${marketStats.median.toFixed(2)}
- Lowest Buy It Now (with shipping): $${marketStats.lowBuyItNow.toFixed(2)}
Recent sales: ${marketStats.recentSales.map(s => `"${s.title}" $${s.totalPrice.toFixed(2)}`).join('; ')}

USE THIS DATA to set a competitive, realistic price. Your suggested price should be informed by these actual sales.`;
        }
      }
    } catch (err) {
      console.error('Market data lookup failed (non-fatal):', err.message);
    }

    content.push({
      type: 'text',
      text: `You are an expert eBay seller with 20 years of experience maximizing sales.
Analyze ${photos.length > 0 ? 'these photos' : 'this description'} and create an optimized eBay listing.${description ? `\nSeller notes: ${description}` : ''}${shippingContext ? `\nShipping info: ${shippingContext}` : ''}${marketContext}

Use your knowledge to estimate the item's real-world weight and dimensions.

USPS flat rate prices (2024):
- Flat Rate Envelope (12.5x9.5"): $10.10 — thin flat items, documents, soft goods under ~4 lbs
- Padded Flat Rate Envelope (12.5x9.5"): $10.45 — small items needing protection, small electronics, jewelry
- Small Flat Rate Box (8.625x5.375x1.625"): $11.15 — small dense items
- Medium Flat Rate Box (11x8.5x5.5"): $17.10 — fits most shoe-box sized items
- Large Flat Rate Box (12x12x5.5"): $22.10 — large heavy items
USPS Ground Advantage typical rates: under 1lb ~$5, 1-2lb ~$8, 2-5lb ~$11, 5-10lb ~$14, 10-20lb ~$18

Determine: does this item fit in any flat rate option? Pick the CHEAPEST flat rate option the item fits in. If so, compare that flat rate price vs estimated Ground Advantage cost. Flat rate is "recommended" when it's cheaper OR when the item is heavy enough that flat rate saves money.

${isFreeShipping ? `FREE SHIPPING MODE: The seller wants to offer free shipping. You MUST:
1. Build the estimated shipping cost INTO the item price (price should be item value + shipping)
2. Set shippingNote to "Free Shipping"
3. Flat rate recommendation still applies — but the buyer won't see it (seller pays)
4. In priceReasoning, mention that the price includes built-in shipping` : ''}

Respond with ONLY valid JSON — no markdown, no code blocks, nothing else:
{
  "title": "keyword-rich SEO title under 80 characters",
  "condition": "NEW" or "LIKE_NEW" or "USED_EXCELLENT" or "USED_GOOD" or "USED_ACCEPTABLE" or "FOR_PARTS",
  "conditionNote": "honest 1-sentence condition note",
  "price": <suggested price as a plain number>,
  "priceLow": <quick-sale price>,
  "priceHigh": <patient/optimistic price>,
  "priceReasoning": "2-3 sentences explaining the price — reference comparable sales if market data was provided",
  "description": "compelling 3-paragraph description covering what it is, key features/specs, condition details and what's included",
  "categoryName": "specific eBay category (e.g. 'Vintage Cameras & Photo', 'Men's Coats & Jackets')",
  "shippingNote": ${isFreeShipping ? '"Free Shipping"' : '"best non-flat-rate option with cost range, e.g. USPS Ground Advantage approx $8-11"'},
  "freeShipping": ${isFreeShipping},
  "shippingBuiltIn": ${isFreeShipping ? '<estimated shipping cost that was added to price, as a number>' : 'null'},
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
    listing.marketStats = marketStats;
    res.json(listing);

  } catch (err) {
    photos.forEach(p => { try { fs.unlinkSync(p.path); } catch {} });
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate listing' });
  }
});

// ─── Valuate Only ────────────────────────────────────────────────────────────

app.post('/valuate', requireAuth, upload.array('photos', 10), async (req, res) => {
  const photos = req.files || [];

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const content = [];

    for (const photo of photos) {
      let imageBuffer = fs.readFileSync(photo.path);
      let mimeType = photo.mimetype || 'image/jpeg';

      const isHeic = mimeType === 'image/heic' || mimeType === 'image/heif'
        || photo.originalname.toLowerCase().endsWith('.heic')
        || photo.originalname.toLowerCase().endsWith('.heif');

      if (isHeic) {
        const converted = await heicConvert({ buffer: imageBuffer, format: 'JPEG', quality: 0.85 });
        imageBuffer = Buffer.from(converted);
        mimeType = 'image/jpeg';
      }

      imageBuffer = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      mimeType = 'image/jpeg';

      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: imageBuffer.toString('base64') }
      });
    }

    const { description } = req.body;

    // Step 1: Ask Claude to identify the item for search
    content.push({
      type: 'text',
      text: `You are an expert eBay seller and appraiser. Identify this item from the photos${description ? ` and seller notes: "${description}"` : ''}.

Respond with ONLY valid JSON:
{
  "itemName": "concise name for eBay search (e.g. 'Canon AE-1 35mm Film Camera')",
  "searchQuery": "optimized eBay search keywords to find comparable sold listings",
  "condition": "NEW" or "LIKE_NEW" or "USED_EXCELLENT" or "USED_GOOD" or "USED_ACCEPTABLE" or "FOR_PARTS",
  "estimatedValue": <your best guess price as a number before seeing market data>,
  "category": "eBay category name"
}`
    });

    const identifyRes = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content }]
    });

    let identification;
    const idText = identifyRes.content[0].text.trim();
    try {
      identification = JSON.parse(idText);
    } catch {
      const match = idText.match(/\{[\s\S]*\}/);
      if (match) identification = JSON.parse(match[0]);
      else throw new Error('Could not parse identification from Claude');
    }

    // Step 2: Search eBay sold listings
    const soldItems = await searchSoldListings(identification.searchQuery);
    const marketStats = computeMarketStats(soldItems);

    // Step 3: Ask Claude to analyze market data and give final valuation
    const valuationPrompt = [];
    valuationPrompt.push({
      type: 'text',
      text: `You are an expert eBay seller and appraiser. You identified this item as: "${identification.itemName}" in ${identification.condition} condition.

${marketStats ? `Here are recent eBay sold listings for comparable items:
- ${marketStats.count} sales found
- Price range: $${marketStats.low.toFixed(2)} – $${marketStats.high.toFixed(2)} (including shipping)
- Average sold price: $${marketStats.average.toFixed(2)}
- Median sold price: $${marketStats.median.toFixed(2)}
- Lowest Buy It Now (with shipping): $${marketStats.lowBuyItNow.toFixed(2)}

Recent comparable sales:
${marketStats.recentSales.map(s => `• "${s.title}" — $${s.price.toFixed(2)} + $${s.shippingCost.toFixed(2)} shipping (${s.condition}, ${s.listingType})`).join('\n')}
` : 'No eBay sold data available — provide your best estimate based on expertise.'}

Based on ${marketStats ? 'the market data above and ' : ''}your expertise, provide a valuation.

Respond with ONLY valid JSON:
{
  "itemName": "${identification.itemName}",
  "category": "${identification.category}",
  "condition": "${identification.condition}",
  "priceLow": <conservative/quick-sale price>,
  "priceMid": <fair market value>,
  "priceHigh": <optimistic/patient seller price>,
  "suggestedListPrice": <what you'd actually list it at>,
  "reasoning": "2-3 sentences explaining the valuation — reference specific comparable sales if available, explain what drives the price range",
  "tips": ["array of 2-3 short tips to maximize value on this specific item"],
  "hasMarketData": ${!!marketStats}
}`
    });

    const valuationRes = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: valuationPrompt }]
    });

    let valuation;
    const valText = valuationRes.content[0].text.trim();
    try {
      valuation = JSON.parse(valText);
    } catch {
      const match = valText.match(/\{[\s\S]*\}/);
      if (match) valuation = JSON.parse(match[0]);
      else throw new Error('Could not parse valuation from Claude');
    }

    // Merge market stats into response
    valuation.marketStats = marketStats;
    valuation.photoFiles = photos.map(p => p.filename);

    res.json(valuation);

  } catch (err) {
    photos.forEach(p => { try { fs.unlinkSync(p.path); } catch {} });
    console.error('Valuate error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to valuate item' });
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
      `${EBAY_URLS.api}/sell/inventory/v1/inventory_item/${sku}`,
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
      `${EBAY_URLS.api}/sell/inventory/v1/offer`,
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

app.listen(PORT, () => {
  console.log(`DraftIt running on port ${PORT}`);
  // Verify Google Sheets connection on startup
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const sheets = getSheetsClient();
      sheets.spreadsheets.values.get({
        spreadsheetId: LAZZ_SHEET_ID,
        range: 'A1:F1',
      }).then(r => {
        console.log('[Lazz] Google Sheets connected OK. Headers:', r.data.values?.[0]);
      }).catch(err => {
        console.error('[Lazz] Google Sheets connection FAILED:', err.message);
        if (err.response?.data?.error) console.error('[Lazz] Details:', JSON.stringify(err.response.data.error));
      });
    } catch (err) {
      console.error('[Lazz] Could not initialize Sheets client:', err.message);
    }
  } else {
    console.log('[Lazz] GOOGLE_SERVICE_ACCOUNT_JSON not set — Sheets sync disabled');
  }
});
