// ─────────────────────────────────────────────────────────────────────────────
// PayFast — Node.js Backend for Hostinger
// Run: node server.js
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const qs        = require('qs');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');

const {
  MERCHANT_ID,
  SECURED_KEY,
  // UAT (sandbox) = ipguat.apps.net.pk  ← use this for testing
  // Production    = verify URL from your PayFast merchant portal
  PAYFAST_BASE_URL = 'https://ipguat.apps.net.pk/Ecommerce/api',
  SUCCESS_URL      = 'https://doctor-diet.pk/checkout/success',
  FAILURE_URL      = 'https://doctor-diet.pk/checkout/cancel',
  // During dev set this to: http://localhost:5173 (your Vite port)
  // In production set this to your actual frontend domain
  ALLOWED_ORIGIN   = 'http://localhost:5173',
  PORT             = 3001,
  NODE_ENV         = 'development',
} = process.env;

if (!MERCHANT_ID || !SECURED_KEY) {
  console.error('❌ MERCHANT_ID and SECURED_KEY must be set in .env');
  process.exit(1);
}

const CHECKOUT_URL = `${PAYFAST_BASE_URL}/Transaction/PostTransaction`;
const TOKEN_URL    = `${PAYFAST_BASE_URL}/Transaction/GetAccessToken`;

// ─── MD5 Secure Hash ─────────────────────────────────────────────────────────
function makeSecureHash(merchantId, securedKey, basketId, amount) {
  return crypto
    .createHash('md5')
    .update(`${merchantId}${securedKey}${basketId}${amount}`)
    .digest('hex');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatPhone(phone) {
  const cleaned = phone.replace(/[\s\-\+]/g, '');
  if (cleaned.startsWith('92')) return `92-${cleaned.slice(2)}`;
  if (cleaned.startsWith('0'))  return `92-${cleaned.slice(1)}`;
  return `92-${cleaned}`;
}

function formatAmount(amount) {
  return Number(amount).toFixed(2);
}

function formatOrderDate(dateStr) {
  // YYYYMMDDHHmmss → "YYYY-MM-DD HH:mm:ss"
  return `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)} ${dateStr.slice(8,10)}:${dateStr.slice(10,12)}:${dateStr.slice(12,14)}`;
}

function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────
function validateCheckoutBody(body) {
  const errors = [];
  const { basketId, orderDate, amount, customerName, customerPhone, customerEmail } = body;

  if (!basketId || typeof basketId !== 'string' || basketId.length > 50)
    errors.push('basketId is required and must be under 50 characters');
  if (!orderDate || !/^\d{14}$/.test(orderDate))
    errors.push('orderDate must be 14 digits: YYYYMMDDHHmmss');
  const amt = Number(amount);
  if (!amount || isNaN(amt) || amt <= 0 || amt > 1000000)
    errors.push('amount must be a positive number up to 1,000,000');
  if (!customerName || customerName.trim().length < 2 || customerName.length > 100)
    errors.push('customerName must be 2–100 characters');
  if (!customerPhone || !/^[\d\s\-\+]{10,15}$/.test(customerPhone))
    errors.push('customerPhone is invalid');
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!customerEmail || !emailRegex.test(customerEmail))
    errors.push('customerEmail is invalid');

  return errors;
}

// ─── Extract token from PayFast response ──────────────────────────────────────
function extractToken(data) {
  return (
    data?.ACCESS_TOKEN ||
    data?.access_token ||
    data?.AccessToken  ||
    data?.Token        ||
    data?.token        ||
    null
  );
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// CORS — allow your frontend origin
app.use(cors({
  origin: NODE_ENV === 'production' ? ALLOWED_ORIGIN : '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── Rate limiters ────────────────────────────────────────────────────────────
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: NODE_ENV, payfast: PAYFAST_BASE_URL });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/checkout
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/checkout', checkoutLimiter, async (req, res) => {
  const reqId    = crypto.randomUUID();
  const clientIp = getClientIp(req);
  console.log(`[${reqId}] Checkout initiated — IP: ${clientIp}, basket: ${req.body?.basketId}`);

  // 1. Validate
  const errors = validateCheckoutBody(req.body);
  if (errors.length) {
    console.warn(`[${reqId}] Validation failed:`, errors);
    return res.status(400).json({ success: false, errors });
  }

  const {
    basketId,
    orderDate,
    amount,
    customerName,
    customerPhone,
    customerEmail,
    customerCity  = 'Karachi',
    planName      = 'Plan',
    billingCycle  = 'Monthly',
    successUrl    = SUCCESS_URL,
    failureUrl    = FAILURE_URL,
  } = req.body;

  const amountStr      = formatAmount(amount);
  const formattedDate  = formatOrderDate(orderDate);
  const formattedPhone = formatPhone(customerPhone);
  const secureHash     = makeSecureHash(MERCHANT_ID, SECURED_KEY, basketId, amountStr);

  // 2. Get access token from PayFast
  let accessToken;
  try {
    console.log(`[${reqId}] Calling GetAccessToken → ${TOKEN_URL}`);

    const tokenRes = await axios.post(TOKEN_URL, qs.stringify({
      MERCHANT_ID,
      SECURED_KEY,
      BASKET_ID:     basketId,
      TXNAMT:        amountStr,
      CURRENCY_CODE: 'PKR',
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    accessToken = extractToken(tokenRes.data);

    if (!accessToken) {
      console.error(`[${reqId}] No token in PayFast response:`, tokenRes.data);
      return res.status(502).json({
        success: false,
        error: 'Payment gateway did not return a token. Please try again.',
      });
    }

    console.log(`[${reqId}] Token obtained ✅`);
  } catch (err) {
    console.error(`[${reqId}] GetAccessToken failed:`, err.message);
    return res.status(502).json({
      success: false,
      error: `Could not connect to payment gateway: ${err.message}`,
    });
  }

  // 3. Build form fields
  const formFields = {
    MERCHANT_ID,
    TOKEN:                  accessToken,
    basket_id:              basketId,
    txnamt:                 amountStr,
    currency_code:          'PKR',
    order_date:             formattedDate,
    customer_mobile_no:     formattedPhone,
    customer_email_address: customerEmail,
    customer_name:          customerName.trim(),
    customer_city:          customerCity,
    txndesc:                `${planName} - ${billingCycle}`,
    proccode:               '00',
    SUCCESS_URL:            successUrl,
    FAILURE_URL:            failureUrl,
    CHECKOUT_URL:           failureUrl,
    secure_hash:            secureHash,
    VERSION:                'WOOCOM-APPS-PAYMENT-0.9',
  };

  console.log(`[${reqId}] Checkout ready ✅ — basket: ${basketId}, amount: ${amountStr}`);
  return res.json({ success: true, postUrl: CHECKOUT_URL, formFields });
});

// ─── 404 & error handlers ─────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ PayFast backend running on port ${PORT} [${NODE_ENV}]`);
  console.log(`   PayFast URL: ${PAYFAST_BASE_URL}`);
  console.log(`   Allowed origin: ${ALLOWED_ORIGIN}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException',  (err) => console.error('Uncaught exception:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
