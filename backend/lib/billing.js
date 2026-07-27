/**
 * ZK Fitness - Stripe billing helpers.
 *
 * The backend only stores subscription metadata (status, Stripe IDs, expiration).
 * Workout data remains encrypted and opaque to the server.
 */

const Stripe = require('stripe');

let _stripe;
function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  }
  return _stripe;
}

const SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || 'http://localhost:3001/';
const CANCEL_URL = process.env.STRIPE_CANCEL_URL || 'http://localhost:3001/';

function getPriceIds() {
  return {
    monthly: process.env.STRIPE_PRICE_MONTHLY,
    yearly: process.env.STRIPE_PRICE_YEARLY,
    lifetime: process.env.STRIPE_PRICE_LIFETIME,
  };
}

function isBillingConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY) && Boolean(process.env.STRIPE_PRICE_MONTHLY);
}

async function createCheckoutSession({ userId, priceId }) {
  const session = await getStripe().checkout.sessions.create({
    mode: priceId === getPriceIds().lifetime ? 'payment' : 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: CANCEL_URL,
    metadata: { userId: String(userId) },
  });
  return session;
}

async function createBillingPortalSession({ customerId }) {
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: CANCEL_URL,
  });
  return session;
}

async function retrieveCheckoutSession(sessionId) {
  return getStripe().checkout.sessions.retrieve(sessionId, { expand: ['subscription', 'customer'] });
}

function isPaidSubscription(status) {
  return ['active', 'trialing'].includes(status);
}

async function getLatestPaymentIntent(customerId) {
  const list = await getStripe().paymentIntents.list({
    customer: customerId,
    limit: 1,
  });
  return list.data[0] || null;
}

async function createRefund({ paymentIntentId, chargeId }) {
  const params = {};
  if (paymentIntentId) params.payment_intent = paymentIntentId;
  else if (chargeId) params.charge = chargeId;
  return getStripe().refunds.create(params);
}

module.exports = {
  getStripe,
  getPriceIds,
  isBillingConfigured,
  createCheckoutSession,
  createBillingPortalSession,
  retrieveCheckoutSession,
  isPaidSubscription,
  getLatestPaymentIntent,
  createRefund,
};
