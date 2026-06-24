
import crypto from 'crypto';

function generatePromoCode(businessName) {
    const cleanName = businessName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '') // Remove spaces and special characters
        .substring(0, 10);         // Keep it reasonably short
    
    // Append 4 random alphanumeric characters to ensure uniqueness
    const randomString = crypto.randomBytes(2).toString('hex').toUpperCase();
    
    return `${cleanName}-${randomString}`;
}

export async function applyForPartnerAndGeneratePromoCode(supabase, userId, paymentData) {
  const {
    method,
    account_title,
    phone_number,
    bank_name,
    bank_account_number
  } = paymentData;

  if (!userId) {
    throw new Error('User ID is required.');
  }

  if (!method || !['easypaisa', 'jazzcash', 'bank'].includes(method)) {
    throw new Error('Invalid payment method.');
  }

  if (!account_title) {
    throw new Error('Account title is required.');
  }

  if ((method === 'easypaisa' || method === 'jazzcash') && !phone_number) {
    throw new Error('Phone number is required.');
  }

  if (method === 'bank' && (!bank_name || !bank_account_number)) {
    throw new Error('Bank name and bank account number are required.');
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, first_name, username, email')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    throw new Error('User not found.');
  }

  const businessName =
    user.full_name ||
    user.name ||
    user.email?.split('@')[0] ||
    `Partner ${userId}`;

  let { data: partner, error: partnerFetchError } = await supabase
    .from('partner_profiles')
    .select('id, business_name, status')
    .eq('user_id', userId)
    .maybeSingle();

  if (partnerFetchError) {
    throw new Error('You are already a partner');
  }

  if (!partner) {
    const { data: newPartner, error: partnerCreateError } = await supabase
      .from('partner_profiles')
      .insert({
        user_id: userId,
        business_name: businessName,
        status: 'silver',
        total_earnings: 0
      })
      .select('id, business_name, status')
      .single();

    if (partnerCreateError) {
      throw new Error('Try again later');
    }

    partner = newPartner;
  }

  console.log(partner.id);

  const paymentPayload = {
    partner_id: partner.id,
    method,
    account_title,
    account_number: method === 'bank' ? bank_account_number : phone_number,
    bank_name: method === 'bank' ? bank_name : null,
    created_at: new Date().toISOString(),
    is_active: true
  };

  const { error: paymentError } = await supabase
    .from('partner_payment_methods')
    .upsert(paymentPayload);

  if (paymentError) {
    throw new Error('try again later');
  }

  let { data: existingPromoCode, error: promoFetchError } = await supabase
    .from('promo_codes')
    .select('id, code')
    .eq('partner_id', partner.id)
    .eq('is_master', true)
    .maybeSingle();

  if (promoFetchError) {
    throw new Error('try again Later');
  }

  if (existingPromoCode) {
    return {
      message: 'Partner payment method saved successfully.',
      partner,
      promoCode: existingPromoCode.code
    };
  }

  const generatedCode = generatePromoCode(businessName, userId);

  const { data: newPromoCode, error: promoCreateError } = await supabase
    .from('promo_codes')
    .insert({
      partner_id: partner.id,
      code: generatedCode,
      is_master: true,
    })
    .select('id, code')
    .single();

  if (promoCreateError) {
    throw new Error('Try Again later');
  }

  return {
    message: 'Partner application completed successfully.',
    partner,
    promoCode: newPromoCode.code
  };
}

