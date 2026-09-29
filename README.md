# Surf Sync

Uploads surf sessions from a Rip Curl Search GPS watch to Strava, with the GPS track, wave count and conditions.

- `rcs.py`: command-line version you run yourself with your own Strava API app.
- `web/`: the hosted web app, a Cloudflare Worker (`worker.js`) plus a static UI (`public/`).

Surf Sync is not affiliated with Strava or Rip Curl.

## Web app configuration

Secrets are set with `wrangler secret put <NAME>` (use `.dev.vars` for local dev):

| Name | Purpose |
| --- | --- |
| `STRAVA_CLIENT_SECRET` | Strava OAuth client secret |
| `SYNC_MASTER_KEY` | 32-byte base64 AES key used to encrypt stored auto-sync credentials |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | Random string checked when Strava validates the webhook subscription |
| `STRAVA_WEBHOOK_SUBSCRIPTION_ID` | Optional. Webhook events carrying any other subscription id are ignored |
| `SYNC_RUN_TOKEN` | Optional. Enables `POST /api/sync/run` for manual sync runs |

### Strava webhook (deauthorization)

When an athlete revokes access, Strava calls `POST /api/strava/webhook`, and the Worker deletes that athlete's stored data. Create the subscription once, after deploying:

```sh
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=251692 \
  -F client_secret=$STRAVA_CLIENT_SECRET \
  -F callback_url=https://ripcurlstrava.com/api/strava/webhook \
  -F verify_token=$STRAVA_WEBHOOK_VERIFY_TOKEN
```

Save the returned `id` as `STRAVA_WEBHOOK_SUBSCRIPTION_ID`.

### Strava brand assets

Download Strava's official assets from <https://developers.strava.com/guidelines/> and copy these two files, unmodified, into `web/public/strava/`:

- `btn_strava_connect_with_orange.svg`: the "Connect with Strava" button
- `api_logo_pwrdBy_strava_horiz_white.svg`: the "Powered by Strava" logo (white variant, for the dark background)

If the files in the download are named differently, rename them to match, or update the `src` attributes in `web/public/index.html`. Until the files are in place, the page shows plain-text fallbacks.

## Strava athlete-capacity review checklist

New Strava apps are limited to 1 connected athlete. To raise the limit, submit the app for review through the Strava Developer Program. The code side is done in this repo:

- [x] Official "Connect with Strava" button that links to `https://www.strava.com/oauth/authorize`
- [x] "Powered by Strava" logo and a statement that the app isn't affiliated with Strava
- [x] Activity links read "View on Strava" (bold, underlined, `#FC5200`)
- [x] Minimal OAuth scope (`read,activity:write`), and a friendly message when access is denied
- [x] Privacy policy at `/privacy.html`
- [x] Deauthorization webhook deletes stored data; the scheduled sync also deletes data for revoked tokens
- [x] "Sign out & disconnect" revokes access on Strava and deletes server-side data
- [x] Only the athlete id is stored server-side, with no cached Strava profile or activity data
- [x] Each user's data is shown only to that user

These steps are manual:

- [ ] Add the two brand-asset files above
- [ ] Set `STRAVA_WEBHOOK_VERIFY_TOKEN`, deploy, and create the webhook subscription
- [ ] On <https://www.strava.com/settings/api>, rename the app so the name doesn't include "Strava" (for example "Surf Sync"), set the website to `https://ripcurlstrava.com`, and upload an app icon
- [ ] Submit the Developer Program form linked from that page. Include screenshots of the connect flow and an uploaded activity, plus the privacy policy URL
- [ ] If there's no reply within about 10 business days, email developers@strava.com
