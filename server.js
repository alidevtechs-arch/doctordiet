require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const qs      = require('qs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Config ───────────────────────────────────────────────────────────────────
// UAT (sandbox) credentials — use these for testing
// Switch to production credentials + URL when going live
const PAYFAST_BASE_URL = process.env.PAYFAST_BASE_URL || 'https://ipg.apps.net.pk/Ecommerce/api';
const MERCHANT_ID      = process.env.MERCHANT_ID;
const SECURED_KEY      = process.env.SECURED_KEY;
const SUCCESS_URL = process.env.SUCCESS_URL || 'https://doctor-diet.pk/checkout/success';
const FAILURE_URL = process.env.FAILURE_URL || 'https://doctor-diet.pk/checkout/cancel';

// And in formFields, use these directly again:
SUCCESS_URL: successUrl,
FAILURE_URL: failureUrl,
CHECKOUT_URL: failureUrl,

const getClientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '127.0.0.1';

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', payfast: PAYFAST_BASE_URL });
});

// ─── POST /api/checkout ───────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    const customer_ip = getClientIp(req);

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

    // Basic validation
    if (!basketId || !amount || !customerEmail || !customerPhone || !customerName) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const txnamt      = Number(amount).toFixed(2);
    const currency    = 'PKR';

    // Format phone → 92-3XXXXXXXXX
    const cleaned = customerPhone.replace(/[\s\-\+]/g, '');
    const phone   = cleaned.startsWith('92') ? `92-${cleaned.slice(2)}`
                  : cleaned.startsWith('0')  ? `92-${cleaned.slice(1)}`
                  : `92-${cleaned}`;

    // Format date YYYYMMDDHHmmss → "YYYY-MM-DD HH:mm:ss"
    const order_date = orderDate
      ? `${orderDate.slice(0,4)}-${orderDate.slice(4,6)}-${orderDate.slice(6,8)} ${orderDate.slice(8,10)}:${orderDate.slice(10,12)}:${orderDate.slice(12,14)}`
      : new Date().toISOString().replace('T', ' ').substring(0, 19);

    // ── Step 1: Get Access Token ──────────────────────────────────────────────
    const tokenPayload = qs.stringify({
      MERCHANT_ID,
      SECURED_KEY,
      BASKET_ID:     basketId,
      TXNAMT:        txnamt,
      CURRENCY_CODE: currency,
      customer_ip,
    });

    console.log('\n→ GetAccessToken payload:', tokenPayload);

    const tokenRes = await axios.post(
      `${PAYFAST_BASE_URL}/Transaction/GetAccessToken`,
      tokenPayload,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    console.log('← GetAccessToken response:', JSON.stringify(tokenRes.data));

    const token = tokenRes.data?.ACCESS_TOKEN || tokenRes.data?.token;
    if (!token) {
      return res.status(400).json({
        success: false,
        error:  'Could not obtain access token',
        detail: tokenRes.data,
      });
    }

    // ── Step 2: Return form fields for hosted checkout ────────────────────────
    const formFields = {
      MERCHANT_ID,
      TOKEN:                  token,
      BASKET_ID:              basketId,
      TXNAMT:                 txnamt,
      CURRENCY_CODE:          currency,
      ORDER_DATE:             order_date,
      CUSTOMER_MOBILE_NO:     phone,
      CUSTOMER_EMAIL_ADDRESS: customerEmail,
      CUSTOMER_NAME:          customerName.trim(),
      CUSTOMER_CITY:          customerCity,
      TXNDESC:                `${planName} - ${billingCycle}`,
      PAYFAST_SUCCESS_URL:    SUCCESS_URL,  // ← Railway URL
      FAILURE_URL:            FAILURE_URL,  // ← Railway URL
      CHECKOUT_URL:           CHECKOUT_URL,
      VERSION:                'WOOCOM-APPS-PAYMENT-0.9',
    };

    console.log('✅ Checkout ready — basket:', basketId, 'amount:', txnamt);

    return res.json({
      success:  true,
      postUrl:  `${PAYFAST_BASE_URL}/Transaction/PostTransaction`,
      formFields,
    });

  } catch (err) {
    console.error('Checkout error:', err.response?.data || err.message);
    return res.status(502).json({
      success: false,
      error:   `Could not connect to payment gateway: ${err.message}`,
      detail:  err.response?.data,
    });
  }
});

// ─── GET /api/status/:basketId ────────────────────────────────────────────────
app.get('/api/status/:basketId', async (req, res) => {
  try {
    const { token, order_date } = req.query;
    const customer_ip = getClientIp(req);

    const response = await axios.get(
      `${PAYFAST_BASE_URL}/Transaction/GetTransactionStatus/${req.params.basketId}`,
      {
        params: { order_date, customer_ip },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      }
    );
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('Status error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Status check failed', detail: err.response?.data });
  }
});

// ─── Payment redirect handler ─────────────────────────────────────────────────
app.get('/payment/success', (req, res) => {
  // Grab all params PayFast sends and forward them to your React app
  const params = new URLSearchParams(req.query).toString();
  res.redirect(302, `${SUCCESS_URL}?${params}`);
});

app.get('/payment/cancel', (req, res) => {
  const params = new URLSearchParams(req.query).toString();
  res.redirect(302, `${FAILURE_URL}?${params}`);
});

// Also handle POST (PayFast sometimes POSTs the callback)
app.post('/payment/success', (req, res) => {
  const params = new URLSearchParams(req.body).toString();
  res.redirect(302, `${SUCCESS_URL}?${params}`);
});

app.post('/payment/cancel', (req, res) => {
  const params = new URLSearchParams(req.body).toString();
  res.redirect(302, `${FAILURE_URL}?${params}`);
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ PayFast backend running on port ${PORT}`);
  console.log(`   PayFast URL: ${PAYFAST_BASE_URL}`);
  console.log(`   Merchant ID: ${MERCHANT_ID}\n`);
});
