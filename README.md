# HubSpot Dedup Agent

A nightly agent that automatically finds duplicate company records in HubSpot and routes them to a review task queue. Designed for B2B sales teams where CRM data quality directly impacts pipeline visibility.

Requires only two credentials: an **Anthropic or OpenAI API key** and a **HubSpot Service Key**.

---

## What it does

Every night the agent first polls its HubSpot review queue for completed tasks, records those decisions, and then scans your company records for new duplicates. Your team works through the tasks and merges or dismisses. Completed tasks are marked as processed, and dismissed pairs are permanently recorded on the associated company records so they never surface again.

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
Reconcile completed review tasks
(poll HubSpot, record decisions, mark tasks processed)
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

**Idempotency:** before creating a task, the agent checks for an existing open task with the same subject. Completed tasks receive a `DEDUP_PROCESSED` marker only after their company decisions are stored, so interrupted runs retry safely without creating duplicate tasks or decisions.

---

## Prerequisites

- HubSpot account (any tier with API access)
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) or OpenAI API key ([platform.openai.com](https://platform.openai.com/api-keys))
- Any Node.js 20+ host ([Railway](https://railway.app), Render, Fly, a VPS, …)

---

## Setup

### 1. HubSpot Service Key

Create a Service Key at **Settings → Integrations → Service Keys** (or **Development → Keys → Service Keys**) with these scopes:

```
crm.objects.companies.read
crm.objects.deals.read
crm.objects.contacts.read
crm.objects.companies.write
crm.lists.read
crm.objects.contacts.write
crm.schemas.companies.write
crm.schemas.companies.read
```

Copy the key — this is your `HUBSPOT_TOKEN`.

HubSpot Service Keys don't expose separate scopes for tasks, so there are no
`crm.objects.tasks.read` or `crm.objects.tasks.write` scopes to select.

A token from a legacy private app with the same scopes also works. The agent reads completed tasks directly from HubSpot at the start of each live run, so no additional HubSpot automation is required.

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

Your **owner ID** is different from your user ID. In HubSpot, open the
**Contact owner** property and find your name in its list of values. The numeric
value beside your name is your owner ID; use it for `HUBSPOT_TASK_OWNER_ID`.

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
| `ANTHROPIC_API_KEY` | One AI key required | Anthropic API key from console.anthropic.com |
| `OPENAI_API_KEY` | One AI key required | OpenAI API key from platform.openai.com |
| `AI_PROVIDER` | Only if both keys are set | `anthropic` or `openai` |
| `ANTHROPIC_FAST_MODEL` | | Default `claude-haiku-4-5-20251001` |
| `ANTHROPIC_COMPLEX_MODEL` | | Default `claude-sonnet-4-6` |
| `OPENAI_FAST_MODEL` | | Default `gpt-4o-mini` |
| `OPENAI_COMPLEX_MODEL` | | Default `gpt-4.1` |
| `HUBSPOT_TOKEN` | ✅ | Service Key (legacy private app token also works) |
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

Set either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and the agent selects that
provider automatically. If both keys are present, set `AI_PROVIDER` explicitly
so deployments never switch providers by accident. If an AI request fails, the
agent falls back to its deterministic rule-based classifier for that pair.

### 7. Deploy

Any Node.js 20+ host works. For Railway, either use the dashboard (**New Project → Deploy from GitHub repo** → pick your fork of this repo) or the CLI:

```bash
railway login
railway init
railway up
```

Set the environment variables in your host's dashboard (Railway: your service's **Variables** tab). Most hosts inject `PORT` automatically.

---

## Running

Every live run begins by reconciling completed `[Dedup Review]` tasks. Dismissed
pairs are stored on their associated companies, merged records are detected from
their remaining associations, and each handled task receives a
`DEDUP_PROCESSED` marker. Dry runs skip this reconciliation and remain write-free.

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
├── index.js        HTTP server + cron scheduler
├── config.js       Env parsing and validation
├── ai-config.js    AI provider selection
├── ai-common.js    Shared AI prompt and output schema
├── ai.js           Provider-neutral AI classifier
├── anthropic.js    Anthropic adapter
├── openai.js       OpenAI adapter
├── hubspot.js      All HubSpot API calls
├── task-sync.js    Completed review task polling and reconciliation
├── normalize.js    Name normalization and domain parsing
├── signals.js      Signal functions (domain, name, contacts, geo)
├── classify.js     Pair classifier, clustering, survivor selection
├── pipeline.js     Main dedup pipeline orchestration
├── tasks.js        HubSpot task creation and audit notes
└── store.js        dedup_settled_pairs read/write helpers

scripts/
├── dry-run.js           Run one pass in dry-run mode, print to console
├── setup-properties.js  One-time: create HubSpot property group + properties
└── test-create-task.js  Create a single test task to verify queue setup

test/
├── ai-config.test.js
├── classify.test.js
├── normalize.test.js
└── task-sync.test.js
```

---

## License

MIT
