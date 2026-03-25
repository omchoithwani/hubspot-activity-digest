'use strict';

// PayPal REST API — replaces stripe.js
// Uses Node 18+ built-in fetch (no extra dependency needed).

const PAYPAL_BASE = process.env.PAYPAL_SANDBOX === 'true'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// Plan config. Monthly/annual use pre-created PayPal billing plan IDs
// (PAYPAL_PLAN_MONTHLY / PAYPAL_PLAN_ANNUAL set in env).
// Lifetime is a one-time order created on the fly.
const PLANS = {
  monthly: {
    planId: () => process.env.PAYPAL_PLAN_MONTHLY,
    mode: 'subscription',
    label: 'Monthly',
    period: '/ month',
    description: 'Billed monthly, cancel anytime',
  },
  annual: {
    planId: () => process.env.PAYPAL_PLAN_ANNUAL,
    mode: 'subscription',
    label: 'Annual',
    period: '/ year',
    description: 'Save ~28% vs monthly',
    badge: 'Best Value',
  },
  lifetime: {
    planId: null,
    mode: 'order',
    label: 'Lifetime',
    period: 'one-time',
    description: 'Pay once, use forever',
  },
};

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');

  const credentials = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function paypalRequest(method, path, body, accessToken) {
  const token = accessToken || await getAccessToken();
  const res = await fetch(`${PAYPAL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Return display prices from env vars.
 * Set PAYPAL_PRICE_MONTHLY / PAYPAL_PRICE_ANNUAL / PAYPAL_PRICE_LIFETIME
 * to e.g. "$29", "$249", "$499".
 */
async function fetchLivePrices() {
  return {
    monthly: process.env.PAYPAL_PRICE_MONTHLY || '—',
    annual:  process.env.PAYPAL_PRICE_ANNUAL  || '—',
    lifetime: process.env.PAYPAL_PRICE_LIFETIME || '—',
  };
}

/**
 * Create a PayPal checkout for the given plan and return the approval URL
 * to redirect the user to.
 */
async function createCheckoutSession({ user, plan, baseUrl }) {
  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error(`Unknown plan: ${plan}`);

  const appName = process.env.APP_NAME || 'HubSpot Digest';
  const token = await getAccessToken();
  const customId = `${user.id}:${plan}`;

  if (planConfig.mode === 'subscription') {
    const planId = planConfig.planId();
    if (!planId) throw new Error(`PAYPAL_PLAN_${plan.toUpperCase()} is not configured`);

    const subscription = await paypalRequest('POST', '/v1/billing/subscriptions', {
      plan_id: planId,
      custom_id: customId,
      subscriber: { email_address: user.email },
      application_context: {
        brand_name: appName,
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${baseUrl}/billing/success?type=subscription`,
        cancel_url: `${baseUrl}/billing`,
      },
    }, token);

    const link = subscription.links?.find((l) => l.rel === 'approve');
    if (!link) throw new Error('No approval URL returned from PayPal subscription API');
    return link.href;
  }

  // One-time order (lifetime plan)
  const amount = process.env.PAYPAL_AMOUNT_LIFETIME || '499.00';
  const currency = process.env.PAYPAL_CURRENCY || 'USD';

  const order = await paypalRequest('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: currency, value: amount },
      custom_id: customId,
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: appName,
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          landing_page: 'GUEST_CHECKOUT',
          return_url: `${baseUrl}/billing/success?type=order`,
          cancel_url: `${baseUrl}/billing`,
        },
      },
    },
  }, token);

  const link = order.links?.find((l) => l.rel === 'payer-action');
  if (!link) throw new Error('No approval URL returned from PayPal orders API');
  return link.href;
}

/**
 * Capture a PayPal order after user approval.
 * Returns the capture response (contains custom_id for user lookup).
 */
async function captureOrder(orderId) {
  return paypalRequest('POST', `/v2/checkout/orders/${orderId}/capture`, {});
}

/**
 * Fetch a PayPal subscription by ID.
 */
async function getSubscription(subscriptionId) {
  return paypalRequest('GET', `/v1/billing/subscriptions/${subscriptionId}`);
}

/**
 * Verify and handle a PayPal webhook event.
 * Requires PAYPAL_WEBHOOK_ID env var (from PayPal developer dashboard).
 */
async function handleWebhookEvent(rawBody, headers) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set');

  const token = await getAccessToken();
  const bodyObj = Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString()) : rawBody;

  // Verify signature via PayPal API
  const verifyRes = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_algo:         headers['paypal-auth-algo'],
      cert_url:          headers['paypal-cert-url'],
      transmission_id:   headers['paypal-transmission-id'],
      transmission_sig:  headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id:        webhookId,
      webhook_event:     bodyObj,
    }),
  });

  if (!verifyRes.ok) throw new Error(`PayPal webhook verification failed: ${verifyRes.status}`);
  const { verification_status } = await verifyRes.json();
  if (verification_status !== 'SUCCESS') throw new Error('Invalid PayPal webhook signature');

  const { updateUserSubscription, getUserByPaypalSubscription } = require('./db');
  const event = bodyObj;

  if (event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
    const sub = event.resource;
    const [userId, plan] = (sub.custom_id || '').split(':');
    if (!userId) return { handled: false };
    await updateUserSubscription(Number(userId), {
      paypalSubscriptionId: sub.id,
      status: 'active',
    });
    return { handled: true, event: event.event_type, userId: Number(userId), status: 'active' };
  }

  if (event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED' ||
      event.event_type === 'BILLING.SUBSCRIPTION.EXPIRED') {
    const sub = event.resource;
    const user = await getUserByPaypalSubscription(sub.id);
    if (user && user.subscription_status !== 'lifetime') {
      await updateUserSubscription(user.id, { paypalSubscriptionId: null, status: 'cancelled' });
    }
    return { handled: true, event: event.event_type };
  }

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    // Backup path for lifetime orders (primary activation is via /billing/success capture)
    const capture = event.resource;
    const customId = capture.custom_id
      || capture.supplementary_data?.related_ids?.order_id;
    if (!customId) return { handled: false };
    const [userId, plan] = customId.split(':');
    if (!userId || plan !== 'lifetime') return { handled: false };
    await updateUserSubscription(Number(userId), {
      paypalSubscriptionId: capture.id,
      status: 'lifetime',
    });
    return { handled: true, event: event.event_type, userId: Number(userId), status: 'lifetime' };
  }

  return { handled: false, event: event.event_type };
}

module.exports = {
  PLANS,
  fetchLivePrices,
  createCheckoutSession,
  captureOrder,
  getSubscription,
  handleWebhookEvent,
};
