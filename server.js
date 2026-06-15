
import 'dotenv/config'; // Replaces require('dotenv').config()
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js'; // Replaces require() destructuring
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import qs from 'qs';
import bcrypt from 'bcrypt';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
import crypto from 'crypto'; // ✅ add this at the top with your other imports
import {Login, authenticateToken, requireAdmin} from './functions/authentication.js';
import {getAllPartnerPortalData, overview, getTopPartnersByStatusLast30Days, getPendingPartnerCommissionsWithPaymentMethods, markPartnerCommissionsPaidLast30Days} from './functions/admin.js';
import {applyForPartnerAndGeneratePromoCode} from './functions/partner.js';
import {
  updateDiscountSetting,
  updateSevenDayPriceSetting
} from './functions/admin.js';
import { generateDietPlan } from './functions/plan_generation.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ─── Config ───────────────────────────────────────────────────────────────────
// UAT (sandbox) credentials — use these for testing
// Switch to production credentials + URL when going live
const PAYFAST_BASE_URL = process.env.PAYFAST_BASE_URL || 'https://ipg1.apps.net.pk/Ecommerce/api';
const MERCHANT_ID      = process.env.MERCHANT_ID;
const SECURED_KEY      = process.env.SECURED_KEY;
const SUCCESS_URL      = process.env.SUCCESS_URL;    
const FAILURE_URL      = process.env.FAILURE_URL;

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Set this in your Railway Variables tab
});



const getClientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '127.0.0.1';


// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', payfast: PAYFAST_BASE_URL });
});

function generatePromoCode(businessName) {
    const cleanName = businessName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '') // Remove spaces and special characters
        .substring(0, 10);         // Keep it reasonably short
    
    // Append 4 random alphanumeric characters to ensure uniqueness
    const randomString = crypto.randomBytes(2).toString('hex').toUpperCase();
    
    return `${cleanName}-${randomString}`;
}

/**
 * POST /api/partners/apply
 * Creates a partner profile and auto-generates their master promo code.
 */


// Middleware to verify token


// POST /api/referral/confirm
// Fires only after successful GoPayFast redirect
// Looks up the most recent generated_plan for this user+promo,
// then inserts into referral_earnings
app.post('/api/referral/confirm', async (req, res) => {
  const { userId, partnerId, promoCodeId } = req.body;

  if (!userId || !partnerId || !promoCodeId) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    // 1. find the most recent generated_plan for this user
    //    that used this promo code and hasn't been credited yet
    const { data: plan, error: planError } = await supabase
      .from('generated_plans')
      .select('id, plan_duration')
      .eq('user_id',       parseInt(userId))
      .eq('promo_code_id', parseInt(promoCodeId))
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (planError || !plan) {
      // plan not generated yet — that's fine, it will be credited
      // when the plan IS generated (see step 4 in generate route)
      return res.status(404).json({ error: 'No plan found for this promo code yet.' });
    }

    // 2. check if referral_earning already exists for this plan
    //    prevents double insert if user refreshes success page
    const { data: existing } = await supabase
      .from('referral_earnings')
      .select('id')
      .eq('plan_id', plan.id)
      .maybeSingle();

    if (existing) {
      return res.status(200).json({ message: 'Referral already recorded.' });
    }

    // 3. fetch commission rate from settings
    const { data: rateSetting } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'commission_rate')
      .single();

    const commissionRate = parseFloat(rateSetting?.value ?? '15') / 100;

    // 4. get plan price from settings based on plan_duration
    const priceKeyMap = {
      '1-day':  'plan_basic_price',
      '3-days': 'plan_standard_price',
      '7-days': 'plan_premium_price',
    };
    const priceKey = priceKeyMap[plan.plan_duration] ?? 'plan_basic_price';

    const { data: priceSetting } = await supabase
      .from('settings')
      .select('value')
      .eq('key', priceKey)
      .single();

    const planPrice     = parseFloat(priceSetting?.value ?? '19');
    const earningAmount = parseFloat((planPrice * commissionRate).toFixed(2));

    // 5. insert referral_earning
    const { error: earningError } = await supabase
      .from('referral_earnings')
      .insert([{
        partner_id: parseInt(partnerId),
        plan_id:    plan.id,
        amount:     earningAmount,
        status:     'pending',
      }]);

    if (earningError) throw earningError;

    // 6. update partner_profiles.total_earnings running total
    await supabase.rpc('increment_partner_earnings', {
      p_partner_id: parseInt(partnerId),
      p_amount:     earningAmount,
    });

    return res.status(200).json({
      message: 'Referral earning recorded.',
      amount:  earningAmount,
    });

  } catch (err) {
    console.error('Confirm referral error:', err);
    return res.status(500).json({ error: 'Failed to record referral.' });
  }
});


// GET /api/settings/commission — anyone authenticated can read
app.get('/api/settings/commission', authenticateToken, async (req, res) => {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'commission_rate')
    .single();

  if (error) return res.status(500).json({ error: 'Failed to load rate.' });
  return res.json({ commissionRate: parseFloat(data.value) });
});

// PATCH /api/settings/commission — admin only
app.patch('/api/settings/commission', authenticateToken, requireAdmin, async (req, res) => {
  const { rate } = req.body;
  if (!rate || rate < 1 || rate > 100) {
    return res.status(400).json({ error: 'Rate must be between 1 and 100.' });
  }

  const { error } = await supabase
    .from('settings')
    .update({ value: String(rate) })
    .eq('key', 'commission_rate');

  if (error) return res.status(500).json({ error: 'Failed to update rate.' });
  return res.json({ message: 'Commission rate updated.', commissionRate: rate });
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/partners/portal
// Partner tab: the logged-in partner's own stats
// Tables: partner_profiles, promo_codes, referral_earnings, generated_plans
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/partners/portal', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // get partner profile
    const { data: profile, error: profileError } = await supabase
      .from('partner_profiles')
      .select('id, business_name, status, total_earnings')
      .eq('user_id', userId)
      .single();
 
    if (profileError || !profile) {
      return res.status(404).json({ error: 'Partner profile not found.' });
    }

    // inside GET /api/partners/portal
    const { data: setting } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'commission_rate')
      .single();

 
    // get master promo code
    const { data: promoRow } = await supabase
      .from('promo_codes')
      .select('code')
      .eq('partner_id', profile.id)
      .eq('is_master', true)
      .single();
 
    // get all earnings for this partner
    const { data: earnings } = await supabase
      .from('referral_earnings')
      .select('amount, status, created_at, plan_id')
      .eq('partner_id', profile.id)
      .order('created_at', { ascending: false });
 
    const totalEarned = Number(profile.total_earnings || 0).toFixed(2);
    const pendingPayout = earnings?.filter(e => e.status === 'pending').reduce((s, e) => s + parseFloat(e.amount), 0).toFixed(2) ?? '0.00';
    const totalReferrals = earnings?.length ?? 0;
 
    // recent 4 earnings with plan info
    const recentFour = earnings?.slice(0, 4) ?? [];
    const planIds    = recentFour.map(e => e.plan_id).filter(Boolean);
 
    let planDurations = {};
    if (planIds.length) {
      const { data: plans } = await supabase
        .from('generated_plans')
        .select('id, plan_duration')
        .in('id', planIds);
      plans?.forEach(p => { planDurations[p.id] = p.plan_duration; });
    }
 
    const recentEarnings = recentFour.map(e => ({
      patientId: e.plan_id ?? '—',
      plan:      planDurations[e.plan_id] ?? 'Standard',
      amount:    parseFloat(e.amount).toFixed(2),
      date:      new Date(e.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' }),
    }));
 
    // next payout date (1st of next month)
    const next = new Date();
    next.setMonth(next.getMonth() + 1, 1);
    const nextPayoutDate = next.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
 
    const initials = profile.business_name
      .split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
 
    return res.json({
      businessName:    profile.business_name,
      initials,
      partnerType:     'Doctor',        // extend if you add a type column
      commissionRate:  15,              // extend if you add a rate column
      promoCode:       promoRow?.code ?? '—',
      totalReferrals,
      totalEarned,
      pendingPayout,
      conversionRate:  68,              // extend with click tracking to make dynamic
      nextPayoutDate,
      recentEarnings,
       commissionRate: parseFloat(setting?.value ?? '15'),
    });
  } catch (err) {
    console.error('Portal error:', err);
    return res.status(500).json({ error: 'Failed to load partner portal.' });
  }
});


// ✅ Route now uses authenticateToken middleware
app.post('/api/partners/apply', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(userId);
    const result = await applyForPartnerAndGeneratePromoCode(supabase, userId, req.body);

    return res.status(200).json(result);
  } catch (error) {
    console.error('Partner apply error:', error);

    return res.status(500).json({
      error: error.message || 'Failed to apply for partner program.'
    });
  }
});
/**
 * @route   POST /api/ai/generate-diet-plan
 * @desc    Accepts patient vectors, fetches AI plan, and automatically logs it to history
 */
app.post('/api/ai/generate-diet-plan', async (req, res) => {
  try {
    const generatedJson = await generateDietPlan({
      openai,
      supabase,
      ...req.body
    });

    return res.status(200).json(generatedJson);
  } catch (error) {
    console.error('Generation Flow Pipeline Failure:', error);

    return res.status(error.statusCode || 500).json({
      error:
        error.message ||
        'AI generation engine failed to compile nutrition structures.'
    });
  }
});

/**
 * @route   POST /api/payments/fulfill-subscription
 * @desc    Directly inserts a verified client subscription into the subscriptions table
 */
app.post('/api/payments/fulfill-subscription', async (req, res) => {
  const { user_id, plan_name } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'User authentication ID is required.' });
  }
  if (!plan_name) {
    return res.status(400).json({ error: 'Subscription plan type name is required.' });
  }

  try {
    //  FIX: Map the string to your EXACT lowercase database enum keys seen in image_42474b.png
    let subscriptionType = 'starter'; // default fallback matching your enum fields

    if (plan_name.toLowerCase().includes('family')) {
      subscriptionType = 'family';
    } else if (plan_name.toLowerCase().includes('personal')) {
      subscriptionType = 'personal';
    } else if (plan_name.toLowerCase().includes('starter') || plan_name.toLowerCase().includes('basic')) {
      subscriptionType = 'starter';
    } else {
      // If the incoming name is already formatted right (e.g., 'starter', 'personal', 'family')
      subscriptionType = plan_name.toLowerCase().trim();
    }

    // 2. Avoid duplicate active entries for the exact same plan tier
    const { data: existingSub, error: subCheckError } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('user_id', parseInt(user_id, 10))
      .eq('subscription_type', subscriptionType)
      .maybeSingle();

    if (subCheckError) throw subCheckError;

    if (existingSub) {
      return res.status(200).json({
        message: 'This subscription tier is already active for this user profile.',
        subscriptionId: existingSub.id
      });
    }

    // 3. Directly insert into the subscriptions table
    const { data: newSubscription, error: insertError } = await supabase
      .from('subscriptions')
      .insert([
        {
          user_id: parseInt(user_id, 10),
          subscription_type: subscriptionType // Passes perfectly as 'starter', 'personal', or 'family'
        }
      ])
      .select()
      .single();

    if (insertError) throw insertError;

    return res.status(201).json({
      message: 'Subscription successfully recorded and activated.',
      subscription: newSubscription
    });

  } catch (error) {
    console.error('Direct Subscription Provisioning Failure:', error);
    return res.status(500).json({ error: 'Server failed to write subscription mapping record.' });
  }
});
/**
 * @route   POST /api/auth/login
 * @desc    Verify existing user. Fails if user does not exist.
 */
app.post('/api/auth/login', async (req, res) => {
  const { email, password: inputpassword } = req.body;

  try {
    const result = await Login(inputpassword, email, supabase);

    if (!result.success) {
      return res.status(result.statusCode).json({
        error: result.error
      });
    }

    return res.status(200).json({
      message: result.message,
      token: result.token,
      user: result.user
    });

  } catch (error) {
    console.error('Login Error:', error);

    return res.status(500).json({
      error: 'Database operations connection failed.'
    });
  }
});

/**
 * @route   POST /api/auth/register
 * @desc    Create a brand new user profile. Fails if email already exists.
 */
app.post('/api/auth/register', async (req, res) => {
  const { email, username, password, first_name, last_name, role } = req.body;

  // ✅ Validate all required fields
  if (!email || !password || !username) {
    return res.status(400).json({ error: 'Email, username, and password are required.' });
  }

  // ✅ Basic password strength check
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    const cleanEmail = email.toLowerCase().trim();

    // Check for duplicate email
    const { data: existingEmail, error: emailCheckError } = await supabase
      .from('users')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (emailCheckError) throw emailCheckError;

    if (existingEmail) {
      return res.status(409).json({ 
        error: 'This email is already registered. Please log in instead. یہ ای میل پہلے سے رجسٹرڈ ہے۔'
      });
    }

    // ✅ Check for duplicate username
    const { data: existingUsername, error: usernameCheckError } = await supabase
      .from('users')
      .select('id')
      .eq('username', username.trim())
      .maybeSingle();

    if (usernameCheckError) throw usernameCheckError;

    if (existingUsername) {
      return res.status(409).json({ 
        error: 'This username is already taken. Please choose another.'
      });
    }

    // ✅ Hash the password before saving — NEVER store plaintext
    const password_hash = await bcrypt.hash(password, 12);

    // ✅ Whitelist the role — never trust user-supplied roles directly
    const allowedRoles = ['Patient', 'Doctor', 'Admin'];
    const safeRole = allowedRoles.includes(role) ? role : 'Patient';

    // Insert user
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ 
        email: cleanEmail,
        username: username.trim(),
        password: password_hash,          // ✅ hashed password saved
        first_name: first_name?.trim() || null,
        last_name: last_name?.trim() || null,
        role: safeRole,         // ✅ whitelisted role
        is_active: true
      }])
      .select('id, email, username, role')   // ✅ password_hash NOT returned
      .single();

    if (insertError) throw insertError;

    return res.status(201).json({
      message: 'Registration successful.',
      user: newUser
    });

  } catch (error) {
    console.error('Registration Error:', error);
    return res.status(500).json({ error: 'Failed to complete registration.' });
  }
});


// ==========================================
// ADMIN DASHBOARD METRICS ENDPOINTS
// ==========================================

/**
 * @route   GET /api/admin/metrics
 * @desc    Fetch aggregated platform user demographics and subscription counts
 */
app.get('/api/admin/metrics',authenticateToken,requireAdmin, async (req, res) => {
  try {
    const result = await overview(supabase);
    const rankings = await getTopPartnersByStatusLast30Days(supabase);

    return res.status(200).json({
      result,
      rankings
    });

  } catch (error) {
    console.error('Metrics Engine Failure:', error);
    return res.status(500).json({ error: 'Failed to extract system performance metrics.' });
  }
});

app.get('/api/admin/partners/pending-commissions/payment-methods',authenticateToken,requireAdmin,
  async (req, res) => {
    try {
      const result = await getPendingPartnerCommissionsWithPaymentMethods(supabase);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('Pending commissions payment methods API error:', error);

      return res.status(500).json({
        success: false,
        error: 'Failed to load pending partner commissions with payment methods.',
      });
    }
  }
);

app.post('/api/admin/partners/pay-commissions',authenticateToken,requireAdmin,async (req, res) => {
    try {
      const { partner_id, payment_method_id } = req.body;

      const result = await markPartnerCommissionsPaidLast30Days(
        supabase,
        Number(partner_id),
        Number(payment_method_id)
      );

      return res.status(200).json({
        success: true,
        message: 'Partner commissions marked as paid successfully.',
        data: result,
      });
    } catch (error) {
      console.error('Pay partner commissions API error:', error);

      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to pay partner commissions.',
      });
    }
  }
);

app.get('/api/admin/partner/summary',authenticateToken,requireAdmin, async (req, res) => {

  try {
    const result = await getAllPartnerPortalData(supabase);

    return res.status(200).json(result);
  } catch (error) {
    console.error("All partners portal error:", error);

    return res.status(500).json({
      error: "Failed to load partner portal data."
    });
  }

});

app.get('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', ['price_7_day', 'discount']);

    if (error) {
      throw new Error(error.message);
    }

    return res.status(200).json({
      settings: data
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'Failed to load settings.'
    });
  }
});

app.put('/api/admin/settings/discount', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { discount } = req.body;

    const result = await updateDiscountSetting(supabase, discount);

    return res.status(200).json(result);
  } catch (error) {
    console.error('Update discount error:', error);

    return res.status(500).json({
      error: error.message || 'Failed to update discount.'
    });
  }
});

app.put('/api/admin/settings/price-7-day', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { price_7_day } = req.body;

    const result = await updateSevenDayPriceSetting(supabase, price_7_day);

    return res.status(200).json(result);
  } catch (error) {
    console.error('Update 7-day price error:', error);

    return res.status(500).json({
      error: error.message || 'Failed to update 7-day price.'
    });
  }
});


// ==========================================
// PAYMENT CHECKOUT ENDPOINTS
// ==========================================


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
      SUCCESS_URL:            successUrl,
      FAILURE_URL:            failureUrl,
      CHECKOUT_URL:           failureUrl,
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

function iframeBreakResponse(res, targetUrl) {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
  <html>
    <head><title>Redirecting...</title></head>
    <body>
      <script>
        try {
          if (window.self !== window.top) {
            window.top.location.replace(${JSON.stringify(targetUrl)});
          } else {
            window.location.replace(${JSON.stringify(targetUrl)});
          }
        } catch(e) {
          window.location.replace(${JSON.stringify(targetUrl)});
        }
      </script>
      <p>Redirecting, please wait...</p>
    </body>
  </html>`);
}

app.get('/payment/success', (req, res) => {
  const params    = new URLSearchParams(req.query).toString();
  const targetUrl = `${SUCCESS_URL}?${params}`;
  iframeBreakResponse(res, targetUrl);
});

app.post('/payment/success', (req, res) => {
  const params    = new URLSearchParams(req.body).toString();
  const targetUrl = `${SUCCESS_URL}?${params}`;
  iframeBreakResponse(res, targetUrl);
});

app.get('/payment/cancel', (req, res) => {
  const params    = new URLSearchParams(req.query).toString();
  const targetUrl = `${FAILURE_URL_RAILWAY.replace('your-app.up.railway.app', '')}`;
  // Actually point to the React cancel page:
  const cancelTarget = `${process.env.SUCCESS_URL?.replace('/checkout/success', '/checkout/cancel')}?${params}`;
  iframeBreakResponse(res, cancelTarget);
});

app.post('/payment/cancel', (req, res) => {
  const params       = new URLSearchParams(req.body).toString();
  const cancelTarget = `${process.env.SUCCESS_URL?.replace('/checkout/success', '/checkout/cancel')}?${params}`;
  iframeBreakResponse(res, cancelTarget);
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
