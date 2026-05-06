# Render Deployment Guide

SlipIQ is a Vite React app, so deploy it on Render as a **Static Site**.

## Repo Configuration

This repo includes `render.yaml` for Render Blueprint deployment.

Render should use:

- Service type: Static Site
- Branch: `main`
- Build command: `npm install && npm run build`
- Publish directory: `./dist`
- Rewrite rule: `/*` -> `/index.html`

The rewrite is required because SlipIQ uses React Router. Without it, deep links like `/slip`, `/alerts`, or `/profile` can 404 when opened directly.

## Mobile Dashboard Steps

1. Open Render Dashboard.
2. Tap **New**.
3. Choose **Blueprint** if you want Render to read `render.yaml`, or choose **Static Site** manually.
4. Connect GitHub repo:
   `youssefalw2001/Slipiq-Mini-App`
5. Select branch:
   `main`
6. Confirm build settings:
   - Build command: `npm install && npm run build`
   - Publish directory: `./dist`
7. Add Redirect/Rewrites rule if Render does not import it from the blueprint:
   - Source: `/*`
   - Destination: `/index.html`
   - Action: `Rewrite`
8. Deploy.
9. Copy the generated `onrender.com` URL.
10. Use that URL as the Telegram Mini App URL in BotFather later.

## Environment Variables

No real environment variables are required for the static MVP.

When Supabase and Telegram payments are added later, use Render environment variables for public build-time values only. Never put service role keys, bot tokens, or payment secrets into frontend code.

## After Deploy

Test these routes directly in the browser:

- `/`
- `/slip`
- `/myslips`
- `/alerts`
- `/profile`
- `/onboarding`

All should load the app instead of returning a 404.
