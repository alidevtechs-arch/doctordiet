// partnerService.js

export async function getAllPartnerPortalData(supabase) {
  const { data, error } = await supabase
    .from("partner_portal_summary")
    .select("*")
    .order("partner_id", { ascending: true });

  if (error) {
    throw error;
  }

  return data;
}

export async function overview(supabase){
    // 1. Fetch total users breakdown
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('role');

    if (userError) throw userError;

    let totalUsers = users.length;

    // 2. Fetch subscription metrics grouped by type
    const { data: partners, error: partError } = await supabase
      .from('partner_profiles')
      .select('id');


    if (partError) throw partError;

    let totalpartners = partners.length;

    const {data: referredsales, error: referror} = await supabase
        .from('referral_earnings')
        .select('id');

    if (referror) throw referror;
    
    let referred_sales = referredsales.length;

    
    let revenue = referred_sales*999;

    const {data: unpaidsales, error: unerror} = await supabase
        .from('referral_earnings')
        .select('id')
        .eq('status', 'unpaid');


    if (unerror) throw unerror;
    
    let commision_due = unpaidsales.length *999 * 0.3; 


    return {
      Stats: { totalUsers, totalpartners, referred_sales, revenue, commision_due }
    };
}

export async function getTopPartnersByStatusLast30Days(supabase) {
  const { data, error } = await supabase
    .from("top_partner_by_status_last_30_days")
    .select("*")
    .order("status", { ascending: true });

  if (error) {
    throw error;
  }

  return data;
}

export async function getPendingPartnerCommissionsWithPaymentMethods(supabase) {
  const { data: pendingPartners, error: pendingError } = await supabase
    .from('admin_partner_pending_commissions_30d')
    .select(`
      partner_id,
      business_name,
      partner_status,
      pending_amount,
      unpaid_commission_count,
      unpaid_plan_count
    `)
    .order('pending_amount', { ascending: false });

  if (pendingError) {
    console.error('Pending partner commissions error:', pendingError);
    throw new Error('Failed to load pending partner commissions.');
  }

  if (!pendingPartners || pendingPartners.length === 0) {
    return [];
  }

  const partnerIds = pendingPartners.map((partner) => partner.partner_id);

  const { data: paymentMethods, error: paymentError } = await supabase
    .from('partner_payment_methods')
    .select(`
      id,
      partner_id,
      method,
      account_title,
      account_number,
      bank_name,
      is_active
    `)
    .in('partner_id', partnerIds)
    .eq('is_active', true);

  if (paymentError) {
    console.error('Partner payment methods error:', paymentError);
    throw new Error('Failed to load partner payment methods.');
  }

  const paymentMethodByPartnerId = new Map();

  for (const method of paymentMethods || []) {
    paymentMethodByPartnerId.set(method.partner_id, method);
  }

  return pendingPartners.map((partner) => {
    const paymentMethod = paymentMethodByPartnerId.get(partner.partner_id);

    return {
      partner_id: partner.partner_id,
      business_name: partner.business_name,
      partner_status: partner.partner_status,
      pending_amount: partner.pending_amount,
      unpaid_commission_count: partner.unpaid_commission_count,
      unpaid_plan_count: partner.unpaid_plan_count,

      payment_method_id: paymentMethod?.id || null,
      payment_method: paymentMethod?.method || null,
      account_title: paymentMethod?.account_title || null,
      account_number: paymentMethod?.account_number || null,
      bank_name: paymentMethod?.bank_name || null,
    };
  });
}

export async function markPartnerCommissionsPaidLast30Days(supabase,partnerId,paymentMethodId) {
  if (!partnerId) {
    throw new Error('Partner ID is required.');
  }

  if (!paymentMethodId) {
    throw new Error('Payment method ID is required.');
  }

  const { data, error } = await supabase.rpc(
    'mark_partner_commissions_paid_30d',
    {
      p_partner_id: partnerId,
      p_payment_method_id: paymentMethodId,
    }
  );

  if (error) {
    console.error('Mark partner commissions paid error:', error);
    throw new Error(error.message || 'Failed to mark partner commissions as paid.');
  }

  return data?.[0] || null;
}
