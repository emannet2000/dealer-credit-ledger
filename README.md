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
- **Cashier shifts:** open a shift with the cash in the drawer, then close it by counting the cash. The app works out expected cash from collections, refunds, expenses and supplier payments recorded during the shift, and flags any shortage or overage.
- **Monthly period locks:** finalize a month once its accounts are reviewed. Finalized months reject financial changes until the owner reopens them with a reason.
- **Duplicate watch:** scans for repeated payments, credit sales/invoices and expenses within a chosen window and groups them for review, without changing or voiding anything automatically.
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
- **Backups:** automatic daily database and photo snapshots, a complete archive download, and an isolated recovery check.
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

Open http://localhost:3330. The first visit asks you to create the **owner** account. After that, add staff from **Store → Team accounts**.

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `3330` | Web server port |
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
# Review the new/overwritten records, then confirm the printed preview ID:
npm run import -- --confirm <preview-id>
```

You can also sign in as the owner and use **Store → Restore records (.json)**. These older JSON backups exclude photos. Complete server backups include photos in a separate folder inside the downloaded archive.

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

The tests cover sign-in, roles and permissions, DR/OR numbering, atomic stock changes, credit holds, photo uploads, the activity log, backups, database upgrades, dealer portal privacy, online-order status rules, promo and per-product discount pricing, monthly period locks, cashier shift variances and duplicate detection.

## Project layout

```
server.js            starts the web server and daily backups
lib/app.js           API, sign-in, roles and business rules
lib/controls.js      cashier shifts, monthly period locks and duplicate review
lib/governance.js    daily and monthly closing locks
lib/credit.js        balance and overdue rules (selected invoices or oldest delivery first)
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

## Transaction and review workflows

- Saving a sale or return updates its stock in the same database transaction. A sale marked paid on release also creates its linked payment atomically. Edit or void that sale to correct both records together.
- The browser reuses the pending operation's retry key after a failed connection. The server persists its response, so a retry returns the same receipt without posting a second transaction. API clients should send an `Idempotency-Key` header for mutations and reuse it only for retries of the same operation.
- Transaction corrections require a reason and the record version in `If-Match`. Original values are kept in **Transaction → Correction history**. Voids reverse balances and stock; financial records cannot be permanently deleted. Staff can correct only their own entries from today; owners and editors can correct other entries.
- Payment receipts and transaction details show server-calculated allocations. Choose automatic oldest-invoice allocation or apply the full payment amount to specific invoices. Advances remain credit until a delivery consumes them. Allocations are recalculated after corrections or voids; they describe the current ledger.
- **Dealer → Statement by period / Print** produces opening balance, period transactions, closing balance, and outstanding deliveries. Statements can be printed or exported as CSV. Dealers may request statements only for their own account through the API.
- Staff can request a blocked credit sale from the sale form. The owner reviews it in **Store → Credit approvals**, supplies a decision reason, and approves or rejects it. Approval lasts 24 hours, belongs to the requester and the exact sale reviewed, and can be consumed once. Owners can release directly with an override reason.
- Starting preparation reserves an order's stock. Available stock excludes reservations. Cancellation frees the reservation. Recording the linked credit sale releases the order and consumes stock atomically. Released or cancelled orders cannot be moved backwards.
- **Store → Reconcile collections** compares recorded payments with counted totals for every payment method over a date range. Discrepancies require an explanation. Closing locks payments in that period; only the owner can reopen it, with a reason. Preview again if payment totals changed before confirmation.
- Catalog imports and backup restores require a server preview. Review exact record IDs, current/incoming values, duplicate codes or numbers, references, and validation errors before confirming. The whole import commits together; invalid imports write no ledger records. A preview expires in 15 minutes and becomes stale if the ledger changes.
- A uniquely named SQLite safety backup is created before each confirmed import. These `before-import-*.db` files are retained separately from the normal daily-backup retention. Copy them off the server regularly and remove old safety copies according to your retention policy.
- JSON backups include ledger records, approvals, reconciliations, and correction history. Accounts, sessions, and image files are excluded. Restored pending or approved credit requests require a fresh owner review. Existing records absent from a backup are kept.

Database migration 4 adds durable retry receipts and import previews automatically on startup. Use a copy of the production data folder to rehearse the upgrade before deploying. Older clients must be refreshed because stock updates now happen on the server; the separate `/api/stock` mutation is retired.

`npm test` runs API, migration, retry, financial workflow, and browser acceptance checks. The browser check uses `CHROME_PATH` or an installed Chromium executable and is skipped when Chromium is absent.


## Stock history, costs, and dashboard

- **Stock history** lists receipts, starting stock, adjustments, sales, and restocked returns with the recorded time and person. Filter by product, person, type, and stock date. CSV export includes all matching records; the screen shows the latest 300. Voided records remain visible and have no current stock effect.
- **Stock in / adjust → Received stock** accepts supplier, delivery reference, and purchase cost per unit. A new receipt with a cost updates the product's purchase cost for future sales. Owners and editors can also set the purchase cost and usual supplier in Edit Product. Editing an older receipt preserves the current product cost.
- **Profit reports** calculates gross profit from net sales minus saved purchase costs, with daily or monthly grouping and CSV export. New sales save the weighted average cost at posting time. Linked returns use the original sale cost; changing supplier costs later leaves past sale snapshots intact. Transactions missing costs or item details are excluded and counted in a partial-report notice. Opening balances and voids are excluded. Linked restocked returns reverse the original cost; other returns reduce revenue only. Recorded operating expenses are deducted separately. Known stock losses are also deducted, and supplier return carrying-value differences are included. Unknown losses are flagged. Taxes are excluded; this does not measure cash collected.
- **Dashboard → Needs attention** links to overdue dealers, low-stock products, and orders waiting for action. The sidebar has icons, page titles, and a collapse setting saved on this device; phone navigation includes the new pages under More.
- **Dashboard / Store → Server backup status** shows the latest successful database backup, file size, retained file count, and errors. Backups are overdue after 26 hours. Owners and editors can refresh status or use **Back up now**. Scheduled backups run while the server is running. Files are published only after a successful database backup, and status survives restarts. New server snapshots include photo files and checksums. JSON downloads still exclude photos. Use **Check backup recovery** to restore a copy into a temporary folder and check database integrity, record counts, photo references and hashes. The live ledger is never overwritten by this check.


## Purchasing and operating costs

- **Purchase orders** records supplier, expected delivery date, products, quantities and agreed unit costs. **Receive delivery** accepts partial quantities and a unique supplier delivery reference, updates stock and weighted costs atomically, and keeps delivery history. Retry keys prevent duplicate posting; stale orders and quantities above the outstanding balance are rejected. Purchase receipts are locked; use a separate documented stock adjustment for physical corrections.
- Owners and editors can record supplier bill payments up to the value of received goods and void an incorrect payment with a reason. Cancelling a purchase order cancels outstanding quantities while retaining received goods and bills. Purchase orders and expense history cannot be deleted.
- New inventory uses perpetual weighted average costs: inventory value plus receipt cost, divided by stock on hand. New sales save that average; linked restocked returns add back the original sale cost. Sale quantities with live linked returns cannot be changed or voided until the returns are voided. Returns cannot exceed the original quantities. Backdated records use the cost at posting time and do not recalculate prior sales.
- Existing inventory with a known purchase cost uses that as its opening basis. Unknown costs remain unknown and are excluded from profit calculations. An owner or editor can establish an unknown basis in **Edit Product**, entering the opening unit cost and selecting **Establish the cost of current stock**. This does not invent costs for earlier transactions.
- **Operating expenses** records paid expenses by date, category, amount, method, payee and receipt reference. Owners and editors can correct or void an expense with a reason; original values remain in correction history. Profit reports show gross profit, recorded expenses and the result after expenses. Supplier payments are not operating expenses and are not deducted twice.
- **Reorder list** uses the last 30 days of net unit sales, available stock after reservations, outstanding purchase quantities, supplier lead time and desired extra coverage. Suggestions can be exported or used to start a purchase order. Review costs and quantities before creating it.
- Full server backups consist of the `.db` file, its `.manifest.json` file, and the photo folder named in the manifest. Keep these together when copying a backup off the server. Recovery checks verify and copy the set into a temporary directory, open the restored database, check integrity and counts, and verify photo hashes and product references. Old database-only backups require a new full backup before checking photo recovery.


## Supplier credits, approvals, and closing the day

- **Purchase order → Return goods / credit** removes received goods from stock, values their removal at the saved inventory average, and credits the original supplier purchase cost against that order's bill. Returns cannot exceed the quantities already received and not returned. A credit larger than the unpaid bill is owed back to the business; **Receive supplier refund** records actual money received. Returns and refunds have reasoned void actions, history, version checks and retry protection.
- **Stock losses** reports negative manual stock adjustments, including damaged, expired and missing stock and count shortages. Known saved costs reduce profit; unknown costs remain flagged. Supplier return movements are excluded from losses; their credit-versus-carrying-cost difference is reported separately so it is counted once.
- **Payment received → Choose invoices and amounts** allocates the complete payment to selected unpaid invoices for the same dealer. References, dates, amounts and outstanding balances are checked by the server. Corrections cannot void or shrink an invoice while a manual allocation would exceed its balance. Automatic FIFO payments still support advances. Statements, dealer overdue status and the dealer portal use the same allocation rules.
- **Approval controls** has owner-configurable defaults: expenses at ₱5,000, purchase orders at ₱20,000, and manual stock adjustments at ₱10,000 require owner review when entered by another team member. Zero disables a control. Unknown-cost stock adjustments require review when the stock control is enabled. Stock count batches are evaluated together and approved atomically. Owners may post directly. Other team members submit the entry, and an owner reviews its quantities, costs and reason before approving and posting it. Changed versions, stock counts, account access and closed days are rechecked at posting; approvals cannot be reused for another entry.
- **Daily closing** compares each payment channel's opening funds plus dealer collections and supplier refunds, less operating expenses, supplier payments and customer refunds, with the counted balance. Credit sales, stock changes and supplier credit notes are not cash receipts. A difference needs an explanation. A stale preview must be refreshed. Closing locks financial changes for that date; only the owner can reopen it with a reason. Existing collection reconciliations continue to enforce their own locks as well. Closing history can be exported as CSV.
- **Store → Download complete backup (.tar.gz)** builds and verifies a fresh database-and-photo snapshot, then downloads the database, checksum manifest, photo folder and `RESTORE.txt` together. Owners and editors can download it. Records JSON imports exclude photos and accounts; only the owner can restore records, and imports cannot bypass a closed business day. Keep a safety copy of the current database and its WAL/SHM files before restoring a full archive while the server is stopped.

## Cashier handovers, period locks, and duplicate review

- **Cashier shifts** records the business date, register or drawer name and opening cash. Only one shift can be open per account at a time. Closing the shift counts the cash in the drawer and compares it with expected cash: opening cash, plus cash collections and supplier refunds, less customer refunds, cash expenses and supplier payments recorded while the shift was open. A balanced drawer closes without a note; any shortage or overage requires an explanation. Closed shifts keep the opening cash, cash in, cash out, expected total, counted total and variance.
- **Period locks** shows the last 12 months with credit sales, payments, expenses and transaction counts. Owners and editors can finalize a month with a reason. Once finalized, financial changes dated in that month are rejected across transactions, stock movements, expenses, purchases and restored records, using the same daily-closing check. A finalized month can only be reopened by the owner, with a reason; reopening is recorded in the period history. Direct deletion of period locks is blocked.
- **Duplicate watch** scans a configurable look-back window (1–90 days, default 7) for repeated payments to the same dealer for the same amount, repeated credit sales/invoices with matching dealer, amount and items, and repeated expenses with the same payee, category and amount. Each group lists the matching records with dates, references and amounts. Owners and editors confirm a duplicate or mark it a false alarm with a reason. Reviews are advisory: no transaction is voided or edited by the scan, and review decisions are kept in the audit trail and backups.

## Dealer profiles and navigation

Dealer forms and profile cards now include first name, optional middle name, last name, age, gender and nationality. New forms require first and last names. Age can be blank or a whole number from 0 to 120. Existing full-name-only profiles keep their display names until first and last names are entered together; no name parts are guessed. Names are combined for search, receipts and statements. The separate fields are included in dealer CSV exports and backups.

Credit Sale opens centered on desktop and full-screen on phones. Log out is available in the sidebar, including its collapsed icon view, and in the phone's More menu.


## Suppliers, collection follow-up, bank matching, and stock batches

- **Suppliers** stores contact person, phone, email, address, payment terms and notes. Select a directory entry on a new purchase order to save its identity and terms. Purchase history and net unpaid/credit balances are available from the supplier profile. Renaming preserves old names for legacy purchase matching. Archive suppliers instead of deleting history.
- **Purchase order → Apply credit to another bill** moves available credit to another received, unpaid bill from the same supplier. Source credit and target balance are checked together, protected by record versions and retry keys, and the application can be voided with a reason. Applications do not count as cash payments or additional income. Applied credit cannot also be refunded in cash.
- **Batches & expiry** shows batch codes, expiry dates and remaining quantities. Receipts accept one batch per product per delivery; record separate partial deliveries when the same product arrives in multiple batches. Sales allocate the earliest-expiring unexpired units first, leaving unknown-expiry stock until last. Stock is usable through its expiry date and blocked afterward. Expired units remain physically on hand until adjusted out. Reservations cannot be consumed by another stock adjustment. Voids restore batch allocations; a receipt whose units have already been used cannot have its quantity reversed until downstream usage is reversed. Inventory costs remain weighted averages, independent of the physical batch order.
- Opening stock is labelled with unknown batch/expiry details. For older, unclassified products, an owner or editor can use **Classify existing stock** without changing physical quantity or value. Owners and editors can update batch codes and expiry dates. Dashboard alerts flag expired and soon-expiring batches.
- **Collection reminders** lists overdue balances, upcoming dues and open payment promises. Copy the existing reminder text to send it yourself, then record the contact date, channel, outcome, note and optional promise amount/date. Contacts remain in history; later payments reduce the displayed outstanding promise. This feature does not automatically send SMS, email or Messenger messages.
- **Delivery proof** confirms a live itemized sale with recipient, delivered date, drawn signature and optional photo. Sale versions are checked before saving. Changed sale quantities/prices or a void make the proof need review. Replacing proof preserves earlier confirmation metadata and image references; corrections and voids are recorded. Dealers can access only their own delivery proof files.
- **Customer refunds** records actual money paid back from available dealer credit after overpayments or returns, optionally linked to a return. Refunds receive RF numbers, reduce remaining credit, appear as cash outflows in daily closing and bank matching, and do not reduce sales revenue a second time. Refund receipts can be printed. A refund must be voided before reversing the credits it relies on.
- **Operating expenses → Receipts and supporting documents** accepts up to five receipt images or PDFs per expense, up to 10 MB per file. Existing attachments can be removed during a reasoned correction, but files retained by financial history cannot be deleted. Dealer accounts cannot read expense documents. Full backup archives and recovery checks include these files; JSON record exports contain references only.
- **Bank reconciliation → Import statement CSV** accepts ISO `YYYY-MM-DD` dates and signed `Amount` values (positive in, negative out), or separate `Credit` and `Debit` columns. `Description`, `Reference` and transaction `ID` columns are optional. Choose the correct account label and ledger payment method. Up to 2,000 rows can be imported; large imports are split into manageable statement groups. Existing identical lines are skipped; use distinct transaction IDs for otherwise identical legitimate entries.
- Match one or more ledger collections, customer refunds, expenses, supplier payments or supplier refunds whose signed total equals the statement line. An entry cannot be matched twice. Changed or voided ledger records make a saved match need review. Remove the match before reusing an entry, or ignore an unrelated bank line with a reason. Matching and importing statements do not create cash transactions. Reconciliation can be exported as CSV. Owners and editors manage bank matching and customer refunds; staff may record contacts, delivery confirmations and their own document uploads.

New Dealer, Payment Received and Stock in / adjust now open centered on desktop while remaining full-screen on phones.
