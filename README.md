# Dealer Credit Ledger

A web app for direct-selling distributors (for example Personal Collection in the Philippines) who release products to dealers on credit. It tracks dealers, products and stock, credit sales, payments, returns, collections and each dealer's credit history, in pesos.

It runs on Node.js with a built-in SQLite database. There's no separate database server to install.

## Features

- **Credit sales with many items:** pick products from a searchable table, adjust quantity with − / +, priced at SRP with the dealer discount taken off, plus an optional extra discount.
- **Flexible pricing that follows the monthly catalog:**
  - Discounts at three levels: store default (25%), per dealer, and per product (e.g. 0% for net-priced items).
  - Promo prices with start and end dates, applied automatically to sales and online orders dated inside the promo. You choose whether the dealer discount also applies to the promo price.
  - **Update catalog:** paste the new price list from Excel, Google Sheets or a CSV. You get a preview of new products, price changes (old → new), promos and products missing from the new list, then apply it all at once. Dealer prices are recalculated and every SRP change is saved in the product's price history.
- **Full or partial payments:** quick buttons for full balance, overdue only or the oldest delivery, or type any amount. A live preview shows exactly which DRs the payment settles and what's left. Receipts show "Full payment" or "Partial payment" and what the payment was applied to.
- **Adjustments and write-offs:** add a debit or credit that is not a sale, payment or return, or write off bad debt with a required reason. Both are owner/editor only, keep the audit trail, and show correctly in balances, receipts and reports.
- **Automatic numbers:** DR-00001 for sales, OR-00001 for payments, RT-00001 for returns, ADJ-00001 for adjustments and WO-00001 for write-offs. They are assigned by the server, so two people can never get the same number.
- **Payments** (Cash, GCash, Maya, bank transfer, check) applied to the oldest unpaid delivery first.
- **Returns,** with or without putting items back in stock. Link a return to a DR and the app caps quantities at what was delivered and not already returned.
- **Opening balances** for dealers who already owe money.
- **Credit control:** credit limits, automatic credit hold for dealers over 60 days late, and owner approval to release anyway.
- **Cost and gross profit:** save what you paid per product (owner/editor only) and see profit per piece, cost of goods sold, gross profit and margin in the product list and reports. Sale lines snapshot the cost so old profit does not change.
- **Stock reservation and backorders:** open online orders hold stock, so two dealers are not promised the same units. Orders that cannot be filled are flagged as backorders with the short items listed. Stock cannot go below zero unless you turn on backorders in Store settings.
- **Credit history per dealer:** rating (A–D), on-time payment rate, average days to pay, worst delay, last 6 months, a payment record per delivery, and a log of credit limit changes.
- **Collections list** with a ready-to-send Taglish reminder message for Messenger, Viber or SMS.
- **Online orders from dealers:** dealers order from the portal catalog with a pickup date and note. Orders show up live in the **Orders** tab, where you check stock, move them through Preparing → Ready for pickup, then release them as a credit sale in one tap with items and discount already filled in. Dealers see each status change.
- **Dealer portal:** each dealer can have a login that shows only their own balance, due dates, credit limit, receipts, payment history, orders and your catalog with their price. They can't see other dealers, your costs or your stock counts.
- **Receipts:** a delivery receipt (DR), an acknowledgement receipt for payments, a return slip, an adjustment note and a write-off note, with signature lines and the balance after each transaction. Print them or copy them as text. One opens automatically after each sale or payment.
- **12-month chart** of credit sales vs. collections in Reports.
- **Inventory:** stock in, damaged or lost stock, monthly stock count, low-stock alerts, product photos.
- **Reports** by period, product, dealer and payment method, with cost, gross profit, adjustments, write-offs and CSV export.
- **Team accounts** with roles. The server enforces what each role can do:

  | Role | Can do |
  |---|---|
  | Owner | Everything, including adding and disabling accounts |
  | Editor | Settings, credit rules, prices, approving credit holds, editing any record |
  | Staff | Record sales, payments, returns and stock. Edit or void only their own records from today. Can't change prices, credit limits or settings, or release goods to dealers on hold |
  | Viewer | See everything, change nothing |
  | Dealer portal | One dealer's own balance, receipts, history and catalog, plus placing and cancelling their own new orders |

- **Activity log** of every sign-in and change, showing who made it and when.
- **Backups:** an automatic daily copy of the database, an optional offsite copy after each backup, plus a downloadable backup file, a full backup with accounts and photos, and restore from the Store tab.
- **Live updates:** changes appear on everyone's screen within a second.
- **Phone-friendly:** a bottom navigation bar, a big **+** button for new sale, payment, return, stock in, dealer or product, and quick search (**Ctrl+K** or **/**) across dealers, products, DR/OR numbers and orders.

## Requirements

- Node.js 20 or newer
- About 100 MB of disk space, plus room for photos

## Run it on your computer

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

Open http://localhost:3000. The first visit asks you to create the **owner** account. After that, add staff from **Store → Team accounts**.

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `REMINDER_WEBHOOK_URL` | none | Your SMS or email gateway. The app POSTs `{ channel, to, message }` as JSON. Reminders fail visibly until this is set. |
| `REMINDER_WEBHOOK_TOKEN` | none | Sent to the gateway as a bearer token |
| `PUSH_CONTACT` | none | A `mailto:` or `https:` address for phone notifications |
| `API_RATE_LIMIT` | `3000` | Requests per person per minute |
| `DATA_DIR` | `./data` | Where the database, photos and daily backups are stored. **Back up this folder.** |
| `COOKIE_SECURE` | `false` | Set to `true` when the site uses HTTPS. Also turns on the HTTPS redirect and HSTS. **Required when `NODE_ENV=production`.** |
| `ALLOW_INSECURE_HTTP` | — | Set to `true` only to try the production build on a local network without HTTPS. Never on a public server. |
| `STAFF_SESSION_DAYS` | `7` | How long staff and viewer accounts (collectors' phones) stay signed in without being used. Owners and editors stay signed in for 30 days and should turn on two-step sign-in. |
| `TZ` | `Asia/Manila` | Time zone for "today", due dates and staff edit limits |
| `BACKUP_KEEP` | `30` | Number of daily backups to keep |
| `BACKUP_SYNC_CMD` | — | Command run after each daily backup to copy it offsite. The finished file is passed in `BACKUP_FILE`, e.g. `rclone copy "$BACKUP_FILE" remote:ledger-backups`. **Set this before going live.** |
| `ALERT_WEBHOOK_URL` | — | Gets a JSON `{"text": "..."}` POST when a backup or offsite copy fails (works with Slack, Google Chat and Discord-style webhooks) |
| `ALERT_CMD` | — | Command run when a backup or offsite copy fails; the message is in `ALERT_MESSAGE`, e.g. a script that sends an SMS or email |

## Put it online

Any host that runs Node.js and keeps files on disk works. Pick one with a **persistent disk** so the database survives restarts.

**Option A: a small VPS** (DigitalOcean, Linode, Vultr, Hostinger VPS, about US$5–6/month)

```bash
git clone <your-repo-url> dealer-ledger && cd dealer-ledger && npm ci --omit=dev
```

```bash
cp .env.example .env
```

```bash
npx pm2 start server.js --name ledger && npx pm2 save
```

Put Caddy or Nginx in front for HTTPS (Caddy gets a free certificate automatically), then set `COOKIE_SECURE=true`. HTTPS is also required for installing the app on phones and recording payments offline.

**Option B: Docker** (works on Railway, Render, Fly.io or your own server)

```bash
docker build -t dealer-ledger .
```

```bash
docker run -d -p 127.0.0.1:3000:3000 -e COOKIE_SECURE=true -v ledger-data:/data --name ledger dealer-ledger
```

The image sets `NODE_ENV=production`, so it refuses to start without `COOKIE_SECURE=true`.

On Railway, Render or Fly.io, attach a volume mounted at `/data`.

## Going live (HTTPS)

The app must be served over HTTPS before real dealers and money go into it. Passwords and session cookies are otherwise sent in plain text, and phones can't install the app or record payments offline.

1. Point a domain at the server, e.g. `ledger.example.com`.
2. Install [Caddy](https://caddyserver.com) and use this `/etc/caddy/Caddyfile`. Caddy gets and renews the certificate automatically and redirects HTTP to HTTPS:

   ```
   ledger.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

3. In `.env`, set `COOKIE_SECURE=true` and `NODE_ENV=production`, and keep the app listening only on `127.0.0.1` (the Docker example above does this).
4. Restart the app and open `https://ledger.example.com`. Check that `http://` redirects to `https://`.

With `COOKIE_SECURE=true` the app also redirects any plain-HTTP request it receives to HTTPS and sends `Strict-Transport-Security`. Every page is served with a Content-Security-Policy that allows only the app's own scripts and Google Fonts. The app trusts one proxy in front of it for `X-Forwarded-Proto`; don't expose port 3000 directly.

## Accounts and lost phones

- **Two-step sign-in:** each person can turn it on in **Store → Your account** with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy). They get 8 single-use recovery codes. Owners and editors are reminded on the Overview until it is on.
- **Lost phone:** the owner opens the person in **Store → Team accounts** and taps **Sign out everywhere**. When that phone next connects, it deletes the ledger data it saved for offline use. **Reset two-step sign-in** lets someone who lost their authenticator set it up again.
- Changing a password or disabling an account also signs out that person's other devices.

## Privacy

The app has tools for the Data Privacy Act: a privacy notice dealers accept in the portal, consent records, a per-dealer data export, removal of personal data on request, and a log of who opened each dealer's profile. Viewer accounts don't see personal details. See [docs/PRIVACY.md](docs/PRIVACY.md) for what is stored, what the business still has to do (privacy notice, DPO, NPC registration check) and the data breach response steps.

## Backups

The server makes a backup every day in `DATA_DIR/backups/ledger-YYYY-MM-DD.db` and keeps the last `BACKUP_KEEP` days. Each backup is opened and checked with SQLite's integrity check right after it is made. **Store → Server backups** shows the last good backup, whether the offsite copy worked, and a **Back up and verify now** button. Owners and editors also see a warning on the Overview when the last good backup is more than 7 days old, a backup or offsite copy failed, or no offsite copy is set up. Set `ALERT_WEBHOOK_URL` or `ALERT_CMD` to be told about failures right away.

Keep at least one copy off the server with `BACKUP_SYNC_CMD` (for example with [rclone](https://rclone.org) to Google Drive or S3).

### Restoring from a backup

1. Stop the app (`npx pm2 stop ledger` or `docker stop ledger`).
2. Run the restore with the backup you want. It checks the file first, then saves the current database as `ledger.before-restore-<time>.db`:

   ```bash
   npm run restore -- data/backups/ledger-2026-11-03.db
   ```

   With Docker: `docker run --rm -v ledger-data:/data dealer-ledger npm run restore -- /data/backups/ledger-2026-11-03.db`

3. Start the app again and sign in. Photos are not inside the daily backup; they stay in `DATA_DIR/uploads`. Use **Download full backup** in the Store tab for a copy that includes photos and accounts.

Tested on 3 November 2026 with 1,000 dealers and 50,000 transactions (14 MB): making and verifying the backup took 0.2 s and the restore took 0.3 s. To repeat the test: `DATA_DIR=/tmp/ledger-perf node test/perf/seed.js`, then back up and restore that folder.

## Performance

Measured on 3 November 2026 with 1,000 dealers, 300 products and 50,000 transactions (`test/perf/seed.js`, then `test/perf/measure.js` with `CHROME_PATH` set):

| Action | Normal computer | CPU slowed 4× (budget phone) |
|---|---:|---:|
| Record a credit sale / payment (server) | 22 ms / 17 ms | — |
| Switch tabs (Overview, Dealers, Collections, Transactions, Reports) | 0.06–0.23 s | 0.6–1.2 s |
| Open a dealer | 0.3 s | 1.2 s |
| Another device's change shows up | 0.1 s | 0.6 s |
| Open the app, data already on the device | under 0.1 s | 0.2 s |
| Open the app on a new device (downloads 13 MB, sent gzipped as 1.7 MB) | 1.8 s | 4.7 s |

Lists show the most important 100 rows first, with a button to show more.

## Development and tests

| Command | What it runs |
|---|---|
| `npm test` | API tests and tests of the browser's business logic (settlement, aging, statements, payment allocation), including a check that browser and server settle every ledger the same way |
| `npm run test:unit` | Pure functions, with no server |
| `npm run test:property` | Rules checked against thousands of random inputs (`PROPERTY_RUNS=5000` for a longer run) |
| `npm run test:edge` | Hostile, broken and extreme input |
| `npm run test:functional` | Every feature through the real API |
| `npm run test:coverage` | All of the above, with a coverage table |
| `npm run test:e2e` (set `CHROME_PATH` if Chrome isn't found) | Browser tests in headless Chrome: credit sale, payment, offline payment, approval request (skipped without `CHROME_PATH`) |
| `npm run test:all` | Both |

GitHub Actions (`.github/workflows/ci.yml`) runs the dependency audit, `npm test` and the browser tests on Node 20 and 22 for every push and pull request. To make failures block merging, turn on branch protection for `main` in the repository settings and require the **CI** checks.

## Move your data from the claude.ai version

1. In the claude.ai ledger, open **Store → Download backup**.
2. On the server, run:

```bash
npm run import -- path/to/ledger-backup-YYYY-MM-DD.json
```

You can also sign in as the owner and use **Store → Restore from backup**. Photos aren't inside the older JSON backups; use **Download full backup** to include photos and team accounts, or add photos again from the Products tab.

## Forgot a password

The owner can set a new password for anyone in **Store → Team accounts → Edit**. If the owner forgets theirs, run this on the server:

```bash
npm run reset-password -- <username> <new-password>
```

## Backups

- An automatic copy is saved every day in `data/backups/` (the last 30 are kept).
- Set `BACKUP_SYNC_CMD` to copy each finished backup to another disk or cloud folder automatically.
- **Download full backup** in Store includes dealers, products, transactions, settings, team accounts (with password hashes) and product photos. Keep it somewhere safe; anyone with the file can read the data.
- Also copy the whole `data/` folder somewhere else regularly (Google Drive, another computer). A copy kept only on the same server won't help if that server is lost.

## Tests

```bash
npm test
```

The tests cover sign-in, roles and permissions, DR/OR numbering, atomic stock changes, credit holds, photo uploads, the activity log, backups, database upgrades, dealer portal privacy, online-order status rules, promo and per-product discount pricing, adjustments and write-offs, cost-price privacy, negative-stock protection, stock reservation and backorders, sale-linked return limits, full backup/restore and the offsite backup hook.

## Project layout

```
server.js            starts the web server and daily backups
REQUIREMENTS.md      the 88 functional requirements and acceptance criteria
lib/app.js           API, sign-in, roles and business rules
lib/credit.js        balance and overdue rules, shared by the server, staff app and portal
lib/db.js            SQLite database and migrations
lib/ops.js           cash close, collectors, checks, reminders, proof of payment, purchasing, merging
lib/finance.js       payment plans, late fees, costing, lots, delivery, VAT, credit reviews, disputes
lib/push.js          phone notifications
public/index.html    the staff app page
public/app.js        the staff app screens
public/ops.js        the Cash and Buying screens, and the books and reminder panels
public/app.css       the staff app styles
lib/credit.js        balance rules, shared by the server, staff app and portal
public/shim.js       connects the screens to the API (live updates, photos, downloads)
public/login.html    sign-in and first-time setup
public/portal.html   dealer portal (balance, receipts, online ordering)
scripts/             import a backup, reset a password
test/                automated API tests
```

## Notes

- DR/OR numbers are for internal tracking. They aren't BIR-registered official receipts.
- The app is built for one business with a small team. For many branches, separate stores or thousands of users, plan a move to PostgreSQL.
