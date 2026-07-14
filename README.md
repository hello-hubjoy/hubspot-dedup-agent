# HubSpot Dedup Agent

A nightly agent that automatically finds duplicate company records in HubSpot and routes them to a review task queue. Designed for B2B sales teams where CRM data quality directly impacts pipeline visibility.

Requires only two credentials: an **Anthropic API key** and a **HubSpot private app token**.

---

## What it does

Every night the agent scans your HubSpot company records, identifies likely duplicates using a multi-signal classifier, and creates review tasks in a dedicated HubSpot task queue. Your team works through the tasks and merges or dismisses. When a task is completed, a webhook fires and the decision is permanently recorded on both company records — that pair is never surfaced again.

**Signals used to identify duplicates:**
- Domain SLD match (e.g. `acme.com` vs `acme.co`)
- HTTP redirect resolution — catches acquisitions and rebrands (e.g. `oldco.com` redirects to `newco.com`)
- Normalized company name similarity (token Jaccard + edit distance, strips legal suffixes)
- Shared engaged contacts
- Geographic overlap
- Open deal presence (used as a blocker — won't auto-merge companies with active deals)

**Tuned for precision over recall.** A missed duplicate becomes a task. A wrong merge is irreversible.

---

## How it works

```
Nightly cron
    │
    ▼
Fetch company list (or full DB)
    │
    ▼
Build candidate pairs via blocking keys
(domain SLD + name token buckets + HTTP redirect cross-reference)
    │
    ▼
Enrich candidates
(contacts, deals, engagement scores, email domains)
    │
    ▼
Classify each pair → AUTO_MERGE | REVIEW | CONFIRMED_DISTINCT
    │
    ▼
Cluster with union-find (N duplicates = 1 task, not N² tasks)
    │
    ▼
Dispatch
├── AUTO_MERGE (DEDUP_LIVE_MERGE=true) → snapshot → merge → audit note
└── REVIEW (or AUTO_MERGE with live merge off) → HubSpot task
    │
    ▼
Mark companies as scanned (delta filter for next run)
    │
    ▼
Log run summary
```

**Delta scanning:** after the initial backlog run, only companies modified since their last scan are included. A typical nightly run processes tens of companies rather than thousands.

**Idempotency:** before creating a task, the agent checks for an existing open task with the same subject. Re-runs don't produce duplicate tasks.

---

## Prerequisites

- HubSpot account (any tier with API access)
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
- Any Node.js 18+ host ([Railway](https://railway.app), Render, Fly, a VPS, …)

---

## Setup

### 1. HubSpot Private App

Create a private app at **Settings → Integrations → Private Apps** with these scopes:

```
crm.objects.companies.read
crm.objects.companies.write
crm.objects.contacts.read
crm.objects.deals.read
crm.objects.tasks.read
crm.objects.tasks.write
crm.lists.read
```

Copy the token — this is your `HUBSPOT_TOKEN`.

### 2. Create HubSpot Custom Properties

Run the one-time setup script to create the property group and four custom properties on Company records:

```bash
HUBSPOT_TOKEN=your_token HUBSPOT_PORTAL_ID=your_portal_id node scripts/setup-properties.js
```

This creates a `Dedup (Internal)` property group with:
- `dedup_settled_pairs` — stores dismissed/merged pair decisions
- `dedup_last_scanned_at` — drives the delta filter
- `dedup_redirect_domain` — HTTP redirect cache (30-day TTL)
- `dedup_score_cache` — informational score cache

### 3. Create the "Dedup Review" Task Queue

In HubSpot: **Tasks → Queues → Create queue** → name it `Dedup Review`.

To find the queue ID: open the queue in HubSpot and copy the numeric ID from the URL.

### 4. Find your HubSpot Owner ID

Your **owner ID** is different from your user ID. Find it via the API with your private app token:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.hubapi.com/crm/v3/owners?email=you@company.com"
```

Use the `id` field from the response.

### 5. (Optional) Create a company list to scan

If you want to scan a specific list rather than your entire HubSpot company database:

1. Go to **Contacts → Lists** → create an active list of companies
2. Copy the list ID from the URL
3. Set `HUBSPOT_LIST_ID` to that ID

Leave `HUBSPOT_LIST_ID` unset to scan all companies in your portal.

### 6. Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key from console.anthropic.com |
| `HUBSPOT_TOKEN` | ✅ | Private app bearer token |
| `HUBSPOT_PORTAL_ID` | ✅ | Your HubSpot portal ID |
| `HUBSPOT_LIST_ID` | | Company list ID to scan (omit for full DB) |
| `HUBSPOT_TASK_QUEUE_ID` | | "Dedup Review" queue ID |
| `HUBSPOT_TASK_OWNER_ID` | | HubSpot owner ID for task assignment |
| `DEDUP_DRY_RUN` | | `true` (default) — no writes, logs only |
| `DEDUP_LIVE_MERGE` | | `false` (default) — tasks only, no merges |
| `MAX_AUTO_MERGES_PER_RUN` | | Default `25` |
| `MAX_TASKS_PER_RUN` | | Default `30` |
| `DEDUP_SCAN_LIMIT` | | Optional cap on companies scanned per run |
| `DEDUP_CRON` | | Default `0 2 * * *` (2am daily) |
| `CRON_TZ` | | Default `America/Los_Angeles` |

### 7. Deploy

Any Node.js 18+ host works. For Railway:

```bash
railway login
railway init
railway up
```

Set the environment variables in your host's dashboard (Railway: your service's **Variables** tab). Most hosts inject `PORT` automatically.

### 8. Set up the HubSpot Workflow (task-completed webhook)

This is what writes the "dismissed" decision when your team completes a task without merging.

1. Go to **Automations → Workflows → Create workflow**
2. Object type: **Tasks**, trigger: **Task is updated**
3. Filter: `Task status` → `is equal to` → `Completed`
4. Enrollment filter: `Queue` → `is any of` → `Dedup Review`
5. Action: **Send a webhook**
   - Method: `POST`
   - URL: `https://your-deployment-url/dedup-task-completed`
   - Body: `{ "taskId": "{{taskId}}" }` (use the task's object ID token)
6. Turn on **Re-enrollment** so re-completed tasks fire the webhook again

---

## Running

### Dry run (safe — no HubSpot writes)

```bash
DEDUP_DRY_RUN=true node scripts/dry-run.js
```

This prints all candidate pairs, their signals, decisions, and would-be survivors. No tasks created, nothing written. Use this to calibrate before going live.

### Create tasks without merging

```bash
DEDUP_DRY_RUN=false DEDUP_LIVE_MERGE=false node -e "import('./src/pipeline.js').then(m => m.runDedup())"
```

### Kick off a larger backlog scan

```bash
DEDUP_DRY_RUN=false DEDUP_LIVE_MERGE=false MAX_TASKS_PER_RUN=100 node -e "import('./src/pipeline.js').then(m => m.runDedup())"
```

### Trigger a run on a deployed instance

```bash
curl -X POST https://your-deployment-url/dedup-run
```

Results appear in the server logs. Note this endpoint is unauthenticated — if your deployment URL is guessable, put it behind your host's access controls or remove the route from `src/index.js`.

### Test task creation

```bash
node scripts/test-create-task.js
```

Creates a single `[Dedup Review TEST]` task so you can see how it looks in HubSpot before enabling live runs.

---

## Calibration guide

**Before enabling live runs:**

1. Run `scripts/dry-run.js` against your real data
2. Review ~20 REVIEW pairs manually — confirm the signals firing make sense
3. Review ~20 AUTO_MERGE pairs — these are the ones that would merge automatically if `DEDUP_LIVE_MERGE=true`
4. Set `DEDUP_DRY_RUN=false DEDUP_LIVE_MERGE=false` and run with `MAX_TASKS_PER_RUN=30`
5. Work through a week of tasks — check for false positives
6. Only set `DEDUP_LIVE_MERGE=true` after reviewing ~150+ would-be auto-merges with near-zero false positives

**AUTO_MERGE criteria (narrow by design):**
- Identical domain SLD AND name similarity > 0.85
- No open deals on either company
- No geographic conflict
- No shared parent/child relationship

Everything else routes to REVIEW.

---

## How decisions are stored

Each company record has a `dedup_settled_pairs` property (multi-line text) storing pipe-delimited decisions:

```
12345|67890|dismissed
12345|99001|merged
```

The classifier reads this before scoring — settled pairs always return `CONFIRMED_DISTINCT` regardless of signals. This is what prevents already-reviewed pairs from resurfacing.

On agent-executed merges, `consolidateOnMerge()` unions both records' settled pairs onto the survivor and remaps any references to the retired ID before executing the merge API call.

---

## File structure

```
src/
├── index.js        Entry: HTTP server + cron scheduler + webhook endpoint
├── config.js       Env parsing and validation
├── hubspot.js      All HubSpot API calls
├── normalize.js    Name normalization, domain parsing, public-suffix handling
├── signals.js      Signal functions (domain, name, contacts, geo)
├── classify.js     Pair classifier, union-find clustering, survivor selection
├── pipeline.js     Main dedup pipeline orchestration
├── tasks.js        HubSpot task creation and audit notes
└── store.js        dedup_settled_pairs read/write helpers

scripts/
├── dry-run.js           Run one pass in dry-run mode, print to console
├── setup-properties.js  One-time: create HubSpot property group + properties
└── test-create-task.js  Create a single test task to verify queue setup

test/
├── normalize.test.js
└── classify.test.js
```

---

## License

MIT
