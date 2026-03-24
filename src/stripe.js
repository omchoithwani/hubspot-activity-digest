'use strict';

const Stripe = require('stripe');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key);
}

// Plan definitions — price IDs come from env vars
const PLANS = {
  monthly: {
    priceId: () => process.env.STRIPE_PRICE_MONTHLY,
    mode: 'subscription',
    label: 'Monthly',
    period: '/ month',
    description: 'Billed monthly, cancel anytime',
  },
  annual: {
    priceId: () => process.env.STRIPE_PRICE_ANNUAL,
    mode: 'subscription',
    label: 'Annual',
    period: '/ year',
    description: 'Save ~28% vs monthly',
    badge: 'Best Value',
  },
  lifetime: {
    priceId: () => process.env.STRIPE_PRICE_LIFETIME,
    mode: 'payment',
    label: 'Lifetime',
    period: 'one-time',
    description: 'Pay once, use forever',
  },
};

/**
 * Fetch live prices from Stripe for each configured plan.
 * Returns a map of planKey -> formatted price string (e.g. "$29").
 * Falls back to "—" for any plan whose price can't be fetched.
 */
async function fetchLivePrices() {
  try {
    const stripe = getStripe();
    const priceMap = {};
    await Promise.all(
      Object.entries(PLANS).map(async ([key, plan]) => {
        const priceId = plan.priceId();
        if (!priceId) { priceMap[key] = '—'; return; }
        try {
          const price = await stripe.prices.retrieve(priceId);
          const amount = price.unit_amount;
          const currency = (price.currency || 'usd').toUpperCase();
          if (amount == null) { priceMap[key] = '—'; return; }
          const formatted = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency,
            maximumFractionDigits: 0,
          }).format(amount / 100);
          priceMap[key] = formatted;
        } catch {
          priceMap[key] = '—';
        }
      })
    );
    return priceMap;
  } catch {
    return Object.fromEntries(Object.keys(PLANS).map((k) => [k, '—']));
  }
}

async function createCheckoutSession({ user, plan, baseUrl }) {
  const stripe = getStripe();
  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error(`Unknown plan: ${plan}`);

  const priceId = planConfig.priceId();
  if (!priceId) throw new Error(`STRIPE_PRICE_${plan.toUpperCase()} is not configured`);

  const params = {
    mode: planConfig.mode,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/billing`,
    metadata: { userId: String(user.id), plan },
    allow_promotion_codes: true,
  };

  if (user.stripe_customer_id) {
    params.customer = user.stripe_customer_id;
  } else {
    params.customer_email = user.email;
  }

  const session = await stripe.checkout.sessions.create(params);
  return session.url;
}

async function createPortalSession({ customerId, baseUrl }) {
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/billing`,
  });
  return session.url;
}

async function handleWebhookEvent(rawBody, signature) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');

  const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);

  const { updateUserSubscription, getUserByStripeCustomer } = require('./db');

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = Number(session.metadata?.userId);
    const plan = session.metadata?.plan;
    if (!userId) return { handled: false };

    const customerId = session.customer;
    const subscriptionId = session.subscription || null;
    const status = plan === 'lifetime' ? 'lifetime' : 'active';

    await updateUserSubscription(userId, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      status,
      stripePriceId: PLANS[plan]?.priceId() || null,
    });

    return { handled: true, event: event.type, userId, status };
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const user = await getUserByStripeCustomer(sub.customer);
    if (user && user.subscription_status !== 'lifetime') {
      await updateUserSubscription(user.id, {
        stripeCustomerId: sub.customer,
        stripeSubscriptionId: null,
        status: 'cancelled',
        stripePriceId: null,
      });
    }
    return { handled: true, event: event.type };
  }

  if (event.type === 'invoice.payment_failed') {
    console.warn('[stripe] Payment failed for customer:', event.data.object.customer);
    return { handled: false, event: event.type };
  }

  return { handled: false, event: event.type };
}

module.exports = { PLANS, fetchLivePrices, createCheckoutSession, createPortalSession, handleWebhookEvent };
