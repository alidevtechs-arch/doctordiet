
export async function generateDietPlan({
  openai,
  supabase,
  profile,
  medicalHistory,
  labParameters,
  drugHistory,
  foodPreference,
  user_id,
  plan_duration,
  number_of_days,
  promo_code
}) {
  if (!profile || !medicalHistory) {
    const error = new Error('Incomplete clinical parameters received.');
    error.statusCode = 400;
    throw error;
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

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a professional medical API that outputs strict, valid JSON. You must obey the requested number of meal plan days exactly.'
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

  if (Array.isArray(generatedJson.meals)) {
    generatedJson.meals = generatedJson.meals.slice(0, numberOfDays);
  }

  generatedJson.planDuration = duration;
  generatedJson.numberOfDays = numberOfDays;

  if (user_id) {
    await saveGeneratedPlanAndReferralEarning({
      supabase,
      user_id,
      duration,
      generatedJson,
      profile,
      medicalHistory,
      labParameters,
      drugHistory,
      foodPreference,
      promo_code
    });
  }

  return generatedJson;
}

async function saveGeneratedPlanAndReferralEarning({
  supabase,
  user_id,
  duration,
  generatedJson,
  profile,
  medicalHistory,
  labParameters,
  drugHistory,
  foodPreference,
  promo_code
}) {
  let promoCodeId = null;
  let partnerId = null;

  if (promo_code) {
    const { data: promoRow, error: promoError } = await supabase
      .from('promo_codes')
      .select('id, partner_id')
      .eq('code', promo_code)
      .maybeSingle();

    if (promoError) {
      console.error('Promo code lookup failed:', promoError);
    }

    if (promoRow) {
      promoCodeId = promoRow.id;
      partnerId = promoRow.partner_id;
    }
  }

  const { data: insertedPlan, error: dbError } = await supabase
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
        generated_layout: generatedJson,
        promo_code_id: promoCodeId
      }
    ])
    .select('id')
    .single();

  if (dbError) {
    console.error('Database history storage failure:', dbError);
    return;
  }

  if (!insertedPlan?.id || !partnerId) {
    return;
  }

  const referralAmount = await calculateReferralAmount(supabase);

  const { error: earningError } = await supabase
    .from('referral_earnings')
    .insert([
      {
        partner_id: partnerId,
        plan_id: insertedPlan.id,
        amount: referralAmount,
        status: 'unpaid'
      }
    ]);

  if (earningError) {
    console.error('Referral earning storage failure:', earningError);
  }
}

async function calculateReferralAmount(supabase) {
  const { data: commissionRow, error: commissionError } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'commission_rate')
    .single();

  if (commissionError) {
    throw new Error('Failed to load commission rate.');
  }

  const { data: priceRow, error: priceError } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'price_7_day')
    .single();

  if (priceError) {
    throw new Error('Failed to load price.');
  }

  const commissionRate = Number(commissionRow.value);
  const price7Day = Number(priceRow.value);

  if (isNaN(commissionRate) || isNaN(price7Day)) {
    throw new Error('Invalid commission rate or price setting.');
  }

  return (commissionRate / 100) * price7Day;
}

