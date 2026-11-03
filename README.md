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
- **Automatic numbers:** DR-00001 for sales, OR-00001 for payments, RT-00001 for returns. They are assigned by the server, so two people can never get the same number.
- **Payments** (Cash, GCash, Maya, bank transfer, check) applied to the oldest unpaid delivery first.
- **Returns,** with or without putting items back in stock.
- **Opening balances** for dealers who already owe money.
- **Credit control:** credit limits, automatic credit hold for dealers over 60 days late, and owner approval to release anyway.
- **Credit history per dealer:** rating (A–D), on-time payment rate, average days to pay, worst delay, last 6 months, a payment record per delivery, and a log of credit limit changes.
- **Collections list** with a ready-to-send Taglish reminder message for Messenger, Viber or SMS.
- **Online orders from dealers:** dealers order from the portal catalog with a pickup date and note. Orders show up live in the **Orders** tab, where you check stock, move them through Preparing → Ready for pickup, then release them as a credit sale in one tap with items and discount already filled in. Dealers see each status change.
- **Dealer portal:** each dealer can have a login that shows only their own balance, due dates, credit limit, receipts, payment history, orders and your catalog with their price. They can't see other dealers, your costs or your stock counts.
- **Receipts:** a delivery receipt (DR), an acknowledgement receipt for payments, and a return slip, with signature lines and the balance after each transaction. Print them or copy them as text. One opens automatically after each sale or payment.
- **12-month chart** of credit sales vs. collections in Reports.
- **Inventory:** stock in, damaged or lost stock, monthly stock count, low-stock alerts, product photos.
- **Reports** by period, product, dealer and payment method, with CSV export.
- **Team accounts** with roles. The server enforces what each role can do:

  | Role | Can do |
  |---|---|
  | Owner | Everything, including adding and disabling accounts |
  | Editor | Settings, credit rules, prices, approving credit holds, editing any record |
  | Staff | Record sales, payments, returns and stock. Edit or void only their own records from today. Can't change prices, credit limits or settings, or release goods to dealers on hold |
  | Viewer | See everything, change nothing |
  | Dealer portal | One dealer's own balance, receipts, history and catalog, plus placing and cancelling their own new orders |

- **Activity log** of every sign-in and change, showing who made it and when.
- **Backups:** an automatic daily copy of the database, plus a downloadable backup file and restore from the Store tab.
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
| `DATA_DIR` | `./data` | Where the database, photos and daily backups are stored. **Back up this folder.** |
| `COOKIE_SECURE` | `false` | Set to `true` when the site uses HTTPS |
| `TZ` | `Asia/Manila` | Time zone for "today", due dates and staff edit limits |
| `BACKUP_KEEP` | `30` | Number of daily backups to keep |

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

Put Caddy or Nginx in front for HTTPS (Caddy gets a free certificate automatically), then set `COOKIE_SECURE=true`.

**Option B: Docker** (works on Railway, Render, Fly.io or your own server)

```bash
docker build -t dealer-ledger .
```

```bash
docker run -d -p 3000:3000 -v ledger-data:/data --name ledger dealer-ledger
```

On Railway, Render or Fly.io, attach a volume mounted at `/data`.

## Move your data from the claude.ai version

1. In the claude.ai ledger, open **Store → Download backup**.
2. On the server, run:

```bash
npm run import -- path/to/ledger-backup-YYYY-MM-DD.json
```

You can also sign in as the owner and use **Store → Restore from backup**. Photos aren't inside backup files, so add them again from the Products tab.

## Forgot a password

The owner can set a new password for anyone in **Store → Team accounts → Edit**. If the owner forgets theirs, run this on the server:

```bash
npm run reset-password -- <username> <new-password>
```

## Backups

- An automatic copy is saved every day in `data/backups/` (the last 30 are kept).
- Also copy the whole `data/` folder somewhere else regularly (Google Drive, another computer). A copy kept only on the same server won't help if that server is lost.

## Tests

```bash
npm test
```

The tests cover sign-in, roles and permissions, DR/OR numbering, atomic stock changes, credit holds, photo uploads, the activity log, backups, database upgrades, dealer portal privacy, online-order status rules, and promo and per-product discount pricing.

## Project layout

```
server.js            starts the web server and daily backups
lib/app.js           API, sign-in, roles and business rules
lib/credit.js        balance and overdue rules (oldest delivery paid first)
lib/db.js            SQLite database and migrations
public/index.html    the app screens
public/shim.js       connects the screens to the API (live updates, photos, downloads)
public/login.html    sign-in and first-time setup
public/portal.html   dealer portal (balance, receipts, online ordering)
scripts/             import a backup, reset a password
test/                automated API tests
```

## Notes

- DR/OR numbers are for internal tracking. They aren't BIR-registered official receipts.
- The app is built for one business with a small team. For many branches, separate stores or thousands of users, plan a move to PostgreSQL.
