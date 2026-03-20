# HubSpot Activity Digest

A Node.js application that generates and emails a **daily HubSpot activity digest** — automatically deployed on [Render.com](https://render.com) as a cron job running every day at 5:00 PM EST.

---

## What It Tracks (Last 24 Hours)

| Activity | Details |
|---|---|
| 💼 Deals Created | Name, stage, amount, owner |
| 🔄 Deal Stage Changes | FROM → TO stage with timestamps |
| ✅ Tasks Completed | Subject, type, owner |
| 📞 Calls Logged | Title, direction, duration, owner |
| 📧 Emails Sent | Subject, direction, status, owner |
| 📅 Meetings Booked | Title, start time, outcome, owner |
| 📝 Notes Added | Preview, owner |
| 👤 Contacts Created | Name, email, company, owner |
| 🏢 Companies Created | Name, domain, industry, owner |

---

## Project Structure

```
hubspot-digest/
├── src/
│   ├── digest.js          # Main digest logic (entry point for cron)
│   ├── hubspot.js         # All HubSpot API calls
│   ├── emailTemplate.js   # HTML email template generator
│   └── server.js          # Express server (health check + manual trigger)
├── package.json
├── render.yaml            # Render deployment configuration
├── .env.example           # Environment variable template
└── README.md
```

---

## Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd hubspot-digest
npm install
cp .env.example .env
```

### 2. Create a HubSpot Private App

1. Go to **HubSpot Settings → Integrations → Private Apps**
2. Click **Create a private app**
3. Give it a name (e.g., "Activity Digest")
4. Under **Scopes**, enable:
   - `crm.objects.deals.read`
   - `crm.objects.contacts.read`
   - `crm.objects.companies.read`
   - `crm.schemas.deals.read`
   - `crm.objects.owners.read`
   - `crm.objects.tasks.read` (under CRM Objects)
   - `crm.objects.calls.read`
   - `crm.objects.emails.read`
   - `crm.objects.meetings.read`
   - `crm.objects.notes.read`
   - `forms` (for listing forms and reading form submissions)
   - `transactional-email` (for sending via HubSpot Email API)
5. Click **Create app** and copy the **Access Token**

### 3. Configure Environment Variables

Edit `.env`:

```env
HUBSPOT_ACCESS_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
RECIPIENT_EMAILS=admin@yourcompany.com,manager@yourcompany.com
FROM_EMAIL=digest@yourcompany.com
FROM_NAME=My Company HubSpot Digest
```

### 4. Test Locally

**Run the web server** (health check):
```bash
npm start
# Open http://localhost:3000/health
```

**Send a test digest immediately:**
```bash
npm run test:digest
# or: node src/digest.js --test
```

**Trigger via HTTP** (if server is running):
```bash
curl -X POST http://localhost:3000/trigger \
  -H "Authorization: Bearer your-trigger-token" \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

---

## Deploying to Render

### Option A: Blueprint (Recommended)

Render will automatically detect `render.yaml` and create both services:

1. Connect your GitHub repository in the [Render Dashboard](https://dashboard.render.com)
2. Select **New → Blueprint**
3. Choose your repository
4. Render reads `render.yaml` and creates:
   - **Web Service** (`hubspot-digest`) — health check + manual trigger
   - **Cron Job** (`hubspot-digest-cron`) — runs daily at 22:00 UTC (5 PM EST)

5. In Render Dashboard, set the environment variables for the web service:
   - `HUBSPOT_ACCESS_TOKEN` — your HubSpot private app token
   - `RECIPIENT_EMAILS` — comma-separated email addresses
   - `FROM_EMAIL` — sender address (optional)
   - `TRIGGER_TOKEN` — secure token for the `/trigger` endpoint (optional)

### Option B: Manual Setup

**Web Service:**
- Runtime: Node
- Build Command: `npm install`
- Start Command: `node src/server.js`
- Health Check Path: `/health`

**Cron Job:**
- Runtime: Node
- Schedule: `0 22 * * *` (5 PM EST / 10 PM UTC)
- Build Command: `npm install`
- Start Command: `node src/digest.js`

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | ✅ Yes | — | HubSpot Private App access token |
| `RECIPIENT_EMAILS` | ✅ Yes | — | Comma-separated digest recipient emails |
| `FROM_EMAIL` | No | `digest@aerorev.com` | Sender email (must be verified in HubSpot) |
| `FROM_NAME` | No | `AeroRev HubSpot Digest` | Sender display name |
| `PORT` | No | `3000` | Port for the Express server |
| `NODE_ENV` | No | `development` | Environment (`production` on Render) |
| `TRIGGER_TOKEN` | No | — | Bearer token to protect `/trigger` endpoint |
| `TEST_RECIPIENT_EMAIL` | No | — | Override recipient for test sends |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Simple status message |
| `GET` | `/health` | JSON health status with last run info |
| `POST` | `/trigger` | Manually trigger the digest |

**Trigger endpoint example:**
```bash
curl -X POST https://your-service.onrender.com/trigger \
  -H "Authorization: Bearer your-trigger-token" \
  -H "Content-Type: application/json" \
  -d '{"test": false}'
```

---

## Schedule

The cron job runs at **`0 22 * * *`** (22:00 UTC = 5:00 PM EST).

> **Note on DST:** During Eastern Daylight Time (March–November), EST becomes EDT (UTC-4). If you need the digest at exactly 5 PM local time year-round, change the schedule in `render.yaml`:
> - **EST** (Nov–Mar): `0 22 * * *`
> - **EDT** (Mar–Nov): `0 21 * * *`

---

## Troubleshooting

### "No activities" in the digest
- Check that `HUBSPOT_ACCESS_TOKEN` has all required scopes
- Verify your HubSpot account has activity in the last 24 hours
- Check Render logs for API errors

### Email not sending
- HubSpot transactional email requires a **Marketing Hub** subscription (Starter+)
- The `FROM_EMAIL` must be a verified sending domain in HubSpot
- Check that the `transactional-email` scope is enabled on your Private App

### Rate limit errors (429)
- The app includes automatic retry with exponential backoff
- If persistent, reduce your `RECIPIENT_EMAILS` count or check HubSpot API usage

### Cron job not running
- Verify the cron schedule in `render.yaml` (UTC time)
- Check the Render Dashboard → Cron Jobs → Logs
- Confirm env vars are set on the cron service (inherited from web service via `fromService`)

### Local testing issues
- Copy `.env.example` to `.env` and fill in all values
- Run `node src/digest.js --test` for an immediate test send
- Use `node src/server.js` to test the health check endpoints

---

## HubSpot API Reference

- [CRM Search API](https://developers.hubspot.com/docs/api/crm/search)
- [Transactional Email API](https://developers.hubspot.com/docs/api/marketing/transactional-email)
- [Private Apps](https://developers.hubspot.com/docs/api/private-apps)
- [Owners API](https://developers.hubspot.com/docs/api/crm/owners)
- [Pipelines API](https://developers.hubspot.com/docs/api/crm/pipelines)
