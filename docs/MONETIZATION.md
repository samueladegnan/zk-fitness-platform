# Monetization & Billing

This document contains the commercial details for ZK Fitness. It is kept separate from the main README so the public portfolio page focuses on the technical and privacy-first aspects of the project.

## Business Model

ZK Fitness is free to use locally with no ads. Local mode gives full access to workout tracking, plans, exercise history, charts, and the one-rep-max calculator on any device, with no time limit.

The only paid feature is encrypted cloud sync across devices, because that is the only part that incurs server costs:

| Plan | Price | Best for |
|---|---|---|
| Monthly | $3.99 | Short-term users |
| Yearly | $29.99 | Regular users (save 37%) |
| Lifetime | $79.99 | Long-term users who want to pay once |

Payments are processed by Stripe. The backend stores only subscription metadata; workout data remains encrypted and unreadable by the server.

If you cancel, your local data and all workout features stay fully usable. Cloud sync simply stops until you resubscribe.

## Refund Policy

- **Monthly plan**: cancel anytime; the current billing period is not prorated.
- **Yearly and Lifetime plans**: 14-day money-back guarantee. You can request an automated refund directly from the app within 14 days of purchase. The refund cancels your subscription and returns you to local mode.
- **Local mode**: no payment required. Start it instantly from the login screen by choosing "Try without an account."

## Enabling Billing (Optional)

If you skip this step, the app still works fully offline; the subscription card simply will not appear.

1. In your [Stripe Dashboard](https://dashboard.stripe.com), create three products/prices:
   - **ZK Fitness Monthly** at $3.99 USD, recurring monthly
   - **ZK Fitness Yearly** at $29.99 USD, recurring yearly
   - **ZK Fitness Lifetime** at $79.99 USD, one-time payment
2. Add these environment variables to your backend host:
   | Variable | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_live_...` from Stripe |
   | `STRIPE_WEBHOOK_SECRET` | Webhook signing secret |
   | `STRIPE_PRICE_MONTHLY` | Price ID for monthly plan |
   | `STRIPE_PRICE_YEARLY` | Price ID for yearly plan |
   | `STRIPE_PRICE_LIFETIME` | Price ID for lifetime plan |
   | `STRIPE_SUCCESS_URL` | `https://<username>.github.io/zk-fitness-platform/frontend/` |
   | `STRIPE_CANCEL_URL` | Same as above |
3. Add a webhook endpoint for `checkout.session.completed` pointing to `https://your-api.onrender.com/api/billing/webhook`.
