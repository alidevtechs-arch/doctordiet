
import 'dotenv/config'; // Replaces require('dotenv').config()
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js'; // Replaces require() destructuring
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import qs from 'qs';

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
app.post('/apply', async (req, res) => {
    // 1. Only require userId now
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'Missing userId.' });
    }

    try {
        // 2. Fetch the username from the users table
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('username')
            .eq('id', userId)
            .single();

        if (userError || !user) {
            console.error('User fetch error:', userError);
            return res.status(404).json({ error: 'User not found in database.' });
        }

        const businessName = user.username; // Use username as the business name

        // 3. Insert into partner_profiles table
        const { data: partnerData, error: partnerError } = await supabase
            .from('partner_profiles')
            .insert([{ 
                user_id: userId, 
                business_name: businessName,
                status: 'approved' 
            }])
            .select()
            .single();

        if (partnerError) {
            // Handle unique constraint if they are already a partner
            if (partnerError.code === '23505') {
                return res.status(400).json({ error: 'You are already a registered partner.' });
            }
            return res.status(500).json({ error: 'Failed to create partner profile.' });
        }

        // 4. Generate and insert the unique promo code
        const newPromoCode = generatePromoCode(businessName);
        
        const { data: promoData, error: promoError } = await supabase
            .from('promo_codes')
            .insert([{ partner_id: partnerData.id, code: newPromoCode, is_master: true }])
            .select()
            .single();

        if (promoError) throw promoError;

        // 5. Return success response
        return res.status(201).json({
            message: 'Partner profile created.',
            partner: { businessName: partnerData.business_name },
            promoCode: promoData.code
        });

    } catch (err) {
        console.error('Unexpected server error:', err);
        return res.status(500).json({ error: 'An unexpected error occurred.' });
    }
});
/**
 * @route   POST /api/ai/generate-diet-plan
 * @desc    Accepts patient vectors, fetches AI plan, and automatically logs it to history
 */
app.post('/api/ai/generate-diet-plan', async (req, res) => {
  const {
    profile,
    medicalHistory,
    labParameters,
    drugHistory,
    foodPreference,
    user_id,
    plan_duration,
    number_of_days
  } = req.body;

  if (!profile || !medicalHistory) {
    return res.status(400).json({ error: 'Incomplete clinical parameters received.' });
  }

  const duration =
    plan_duration ||
    foodPreference?.planDuration ||
    '1-day';

  const numberOfDays =
    Number(number_of_days) ||
    (duration === '1-day' || duration === '1-days' ? 1 : 7);

  const clinicalPrompt = `
You are an expert clinical dietitian specializing in clinical nutrition for patients in Pakistan.

Analyze the following multi-step assessment data to construct a comprehensive, disease-specific diet plan.

Patient Profile: ${JSON.stringify(profile)}
Medical History: ${JSON.stringify(medicalHistory)}
Lab Parameters: ${JSON.stringify(labParameters)}
Drug History: ${JSON.stringify(drugHistory)}
Food Preferences: ${JSON.stringify(foodPreference)}

Selected Plan Duration: ${duration}
Number of Days Required: ${numberOfDays}

CRITICAL PLAN DURATION RULE:
- You must generate exactly ${numberOfDays} day(s).
- If Number of Days Required is 1, return ONLY Day 1.
- If Number of Days Required is 1, do NOT return Day 2, Day 3, Day 4, Day 5, Day 6, or Day 7.
- If Number of Days Required is 7, return Day 1 through Day 7.
- The "meals" array must contain exactly ${numberOfDays} object(s).

Requirements:
1. The meal plan structure must be culturally appropriate for Pakistan using local ingredients like Chapati, Daal, Sabzi.
2. Adjust nutrition rules strictly according to lab parameters and medical history.
3. Provide an Urdu explanation summary using simple language in Urdu script.
4. Return your answer strictly as a raw JSON object matching this exact structure with no markdown wrapper around it:

{
  "summary": "Clinical analysis overview string here",
  "urduExplanation": "اردو میں وضاحتی خلاصہ یہاں درج کریں",
  "allowedFoods": ["food item 1"],
  "avoidFoods": ["food item 1"],
  "medicalNotes": "Specific notes here",
  "safetyRules": "Critical compliance red lines here",
  "planDuration": "${duration}",
  "numberOfDays": ${numberOfDays},
  "meals": [
    {
      "day": 1,
      "breakfast": "Items",
      "midMorningSnack": "Items",
      "lunch": "Items",
      "eveningSnack": "Items",
      "dinner": "Items"
    }
  ]
}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a professional medical API that outputs strict, valid JSON. You must obey the requested number of meal plan days exactly.`
        },
        {
          role: 'user',
          content: clinicalPrompt
        }
      ],
      response_format: { type: 'json_object' }
    });

    const rawResponse = completion.choices[0].message.content;
    const generatedJson = JSON.parse(rawResponse);

    // Safety correction: force the meals array to match selected duration
    if (Array.isArray(generatedJson.meals)) {
      generatedJson.meals = generatedJson.meals.slice(0, numberOfDays);
    }

    generatedJson.planDuration = duration;
    generatedJson.numberOfDays = numberOfDays;

    if (user_id) {
      const { error: dbError } = await supabase
        .from('generated_plans')
        .insert([
          {
            user_id: parseInt(user_id, 10),
            plan_duration: duration,
            assessment_inputs: {
              profile,
              medicalHistory,
              labParameters,
              drugHistory,
              foodPreference
            },
            generated_layout: generatedJson
          }
        ]);

      if (dbError) {
        console.error('Database history storage failure:', dbError);
      }
    }

    return res.status(200).json(generatedJson);

  } catch (error) {
    console.error('Generation Flow Pipeline Failure:', error);
    return res.status(500).json({
      error: 'AI generation engine failed to compile nutrition structures.'
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
  const { email, password } = req.body;

  // Validate both fields upfront
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const cleanEmail = email.toLowerCase().trim();

    // ✅ Include password_hash in the select
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('id, email, role, password')  // fetch the hashed password
      .eq('email', cleanEmail)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (!user) {
      return res.status(401).json({ 
        error: 'This account does not exist. Please register first. یہ اکاؤنٹ موجود نہیں ہے۔ پہلے رجسٹریشن کریں۔'
      });
    }

    // ✅ Compare provided password with stored hash
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ 
        error: 'Incorrect password. Please try again. غلط پاس ورڈ۔ دوبارہ کوشش کریں۔'
      });
    }

    // ✅ Never send password_hash back to client
    const { password, ...safeUser } = user;

    // ✅ Issue a JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      message: 'Login successful.',
      token,
      user: safeUser
    });

  } catch (error) {
    console.error('Login Error:', error);
    return res.status(500).json({ error: 'Database operations connection failed.' });
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
        password_hash,          // ✅ hashed password saved
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
app.get('/api/admin/metrics', async (req, res) => {
  try {
    // 1. Fetch total users breakdown
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('role');

    if (userError) throw userError;

    let totalUsers = users.length;
    let totalPatients = users.filter(u => u.role === 'Patient').length;
    let totalDoctors = users.filter(u => u.role === 'Doctor').length;

    // 2. Fetch subscription metrics grouped by type
    const { data: subs, error: subError } = await supabase
      .from('subscriptions')
      .select('subscription_type');

    if (subError) throw subError;

    // Accumulate individual subscription variant counts dynamically
    const subscriptionCounts = {};
    subs.forEach(s => {
      const type = s.subscription_type || 'Unknown';
      subscriptionCounts[type] = (subscriptionCounts[type] || 0) + 1;
    });

    return res.status(200).json({
      userStats: { totalUsers, totalPatients, totalDoctors },
      subscriptionCounts
    });
  } catch (error) {
    console.error('Metrics Engine Failure:', error);
    return res.status(500).json({ error: 'Failed to extract system performance metrics.' });
  }
});

/**
 * @route   GET /api/admin/demo-requests
 * @desc    Fetch individual detailed demo records paired with physical addresses
 */
app.get('/api/admin/demo-requests', async (req, res) => {
  try {
    // Added address column query selection parameters
    const { data: requests, error: reqError } = await supabase
      .from('demo_request')
      .select(`
        id,
        stat,
        created_at,
        user_id,
        address, 
        users (
          username,
          email,
          first_name,
          last_name
        )
      `)
      .order('created_at', { ascending: false });

    if (reqError) throw reqError;

    const todayStr = new Date().toISOString().split('T')[0];
    
    let pendingCount = requests.filter(r => r.stat === 'pending').length;
    let doneCount = requests.filter(r => r.stat === 'done').length;
    let totalRequestsReceivedToday = requests.filter(r => {
      return r.created_at && r.created_at.startsWith(todayStr);
    }).length;

    return res.status(200).json({
      demoStats: { pendingCount, doneCount, totalRequestsReceivedToday },
      requestsList: requests
    });
  } catch (error) {
    console.error('Demo Processing Failure:', error);
    return res.status(500).json({ error: 'Failed to parse operational demo requests.' });
  }
});

/**
 * @route   PUT /api/admin/demo-requests/:id/status
 * @desc    Advance demo operational lifecycle status from pending to done
 */
app.put('/api/admin/demo-requests/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (status !== 'done') {
    return res.status(400).json({ error: 'System architecture permissions strictly allow state transitions to done only.' });
  }

  try {
    const { data: updatedRequest, error: updateError } = await supabase
      .from('demo_request')
      .update({ stat: 'done' })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    return res.status(200).json({
      message: 'Demo request marked as completed successfully.',
      updatedRequest
    });
  } catch (error) {
    console.error('Status Modification Failure:', error);
    return res.status(500).json({ error: 'Failed to update workflow execution status.' });
  }
});


/**
 * @route   POST /api/demo/request
 * @desc    Create a new clinical platform demo request for a user including address
 */
app.post('/api/demo/request', async (req, res) => {
  const { user_id, address } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'User authentication ID is required.' });
  }
  if (!address || !address.trim()) {
    return res.status(400).json({ error: 'A valid operational clinic or residential address is required.' });
  }

  try {
    // Check for duplicate pending requests
    const { data: existingRequest, error: checkError } = await supabase
      .from('demo_request')
      .select('id')
      .eq('user_id', user_id)
      .eq('stat', 'pending')
      .maybeSingle();

    if (checkError) throw checkError;

    if (existingRequest) {
      return res.status(409).json({ 
        error: 'You already have a pending demo request. Our team will contact you shortly!' 
      });
    }

    // Insert the new request with address mapping parameters
    const { data: newRequest, error: insertError } = await supabase
      .from('demo_request')
      .insert([
        { 
          user_id: parseInt(user_id, 10), 
          stat: 'pending',
          address: address.trim() // Writes to your newly added database column
        }
      ])
      .select()
      .single();

    if (insertError) throw insertError;

    return res.status(201).json({
      message: 'Demo request logged successfully.',
      newRequest
    });

  } catch (error) {
    console.error('Demo Insertion Error:', error);
    return res.status(500).json({ error: 'Failed to process demo request on the server.' });
  }
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
