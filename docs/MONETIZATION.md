# Monetization & Billing

> **Note:** ZK Fitness is currently running as a free demo. All features, including encrypted cloud sync, are available without payment. The Stripe billing code remains in the repository but is dormant by default.

## Demo Mode

In the current demo configuration:

- **Local mode** is free and stores encrypted workout data on the device.
- **Cloud sync** is free for all authenticated users in the demo.
- **No subscription prompts** are shown in the app.

## Enabling Billing (Advanced / Optional)

The billing code is preserved for reference but is not required to run the demo. To enable Stripe billing you would need to:

1. Create three products/prices in the [Stripe Dashboard](https://dashboard.stripe.com): monthly, yearly, and lifetime.
2. Set these environment variables:
   | Variable | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_live_...` or `sk_test_...` |
   | `STRIPE_WEBHOOK_SECRET` | Webhook signing secret |
   | `STRIPE_PRICE_MONTHLY` | Price ID for monthly plan |
   | `STRIPE_PRICE_YEARLY` | Price ID for yearly plan |
   | `STRIPE_PRICE_LIFETIME` | Price ID for lifetime plan |
   | `STRIPE_SUCCESS_URL` | `https://<username>.github.io/zk-fitness-platform/frontend/` |
   | `STRIPE_CANCEL_URL` | Same as above |
3. Add a webhook endpoint for `checkout.session.completed` pointing to `https://your-api.onrender.com/api/billing/webhook`.
4. Re-enable the subscription middleware in `backend/server.js` and the subscription card in `frontend/app.js`.

Without these steps the app remains in free demo mode.
