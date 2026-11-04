# Dealer Credit Ledger — Functional Requirements

This document defines the target functional requirements for the Dealer Credit Ledger. It covers the existing product plus the modules needed for a complete credit, inventory and collections system.

- **Document version:** 1.7
- **Application version:** 1.0 (Node.js 20+, SQLite, vanilla JS)
- **Last updated:** 4 November 2026
- **Requirement count:** 88 functional, plus 12 production-readiness items

## How to read this document

| Term | Meaning |
|---|---|
| **FR** | Functional requirement. Each has a stable ID, priority, status, user story and acceptance criteria. |
| **P0** | Must-have for the current release. |
| **P1** | Important for the next release. |
| **P2** | Useful enhancement, scheduled later. |
| **Implemented** | Behaviour exists in the application and is covered by an automated test or manual check. |
| **Partial** | Some behaviour exists, but one or more acceptance criteria are unmet. |
| **Planned** | Not built yet. |

### Status summary

| Module | Range | Total | Implemented | Partial | Planned |
|---|---|---:|---:|---:|---:|
| Credit and receivables | FR-001 – FR-012 | 12 | 12 | 0 | 0 |
| Inventory and procurement | FR-013 – FR-024 | 12 | 12 | 0 | 0 |
| Orders and fulfillment | FR-025 – FR-034 | 10 | 9 | 0 | 1 |
| Pricing and catalog | FR-035 – FR-040 | 6 | 4 | 0 | 2 |
| Returns and adjustments | FR-041 – FR-045 | 5 | 2 | 1 | 2 |
| Reporting and analytics | FR-046 – FR-053 | 8 | 8 | 0 | 0 |
| Security, users and audit | FR-054 – FR-061 | 8 | 8 | 0 | 0 |
| Backup and operations | FR-062 – FR-067 | 6 | 6 | 0 | 0 |
| Platform and integrations | FR-068 – FR-070 | 3 | 1 | 1 | 1 |
| Collections and controls | FR-071 – FR-074 | 4 | 4 | 0 | 0 |
| Dealer relationships (CRM) | FR-075 | 1 | 1 | 0 | 0 |
| Field collections, privacy and growth | FR-076 – FR-082 | 7 | 5 | 1 | 1 |
| Catalog media, approvals and field use | FR-083 – FR-088 | 6 | 5 | 0 | 1 |
| **Total** | | **88** | **77** | **3** | **8** |

### P0 items delivered in this release

- FR-006 — Debit and credit adjustments
- FR-007 — Write-off of bad debt
- FR-016 — Stock reservation for open orders
- FR-017 — Backorder handling
- FR-018 — Negative-stock guard
- FR-022 — Product cost price
- FR-030 — Order credit-hold and over-limit flags
- FR-031 — Order stock-availability flags
- FR-042 — Sale-linked return limits
- FR-050 — Gross-profit reporting
- FR-052 — Adjustment and write-off reporting
- FR-061 — Cost-price privacy
- FR-064 — Full backup with accounts and photos
- FR-065 — Full restore in one request
- FR-066 — Offsite backup hook

---

## A. Credit and receivables

### FR-001 — Record credit sales on terms

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want to release products to a dealer on credit so the amount is tracked against that dealer until it is paid.
- **Acceptance criteria:**
  - A sale stores dealer, date, due date, line items, subtotal, discounts and final amount.
  - The server assigns a unique sequential number in the form `DR-00001`.
  - The dealer's balance increases by the sale amount.
  - The sale appears in the dealer ledger and in reports.

### FR-002 — Record full and partial payments, oldest delivery first

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want to record a payment and have it applied to the oldest unpaid deliveries so collection history stays accurate.
- **Acceptance criteria:**
  - A payment stores date, amount, method, optional reference and note.
  - The server assigns a unique sequential number in the form `OR-00001`.
  - A payment reduces the dealer balance.
  - The applied amounts are allocated oldest delivery first (FIFO).
  - A receipt shows which deliveries were settled and any amount still owed.

### FR-003 — Record an opening balance

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to enter an existing debt when I start using the app so old receivables are not lost.
- **Acceptance criteria:**
  - An opening balance can be created with an amount, date, due date and note.
  - It is treated as a credit sale for aging and balance purposes.
  - It is labelled as an opening balance, not a new delivery.

### FR-004 — Enforce dealer credit limits

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want a warning or block when a sale would exceed a dealer's credit limit so I control exposure.
- **Acceptance criteria:**
  - Each dealer can have a credit limit and payment terms.
  - The app shows the available credit after the current balance.
  - When the setting is enabled, the server rejects a sale that would exceed the limit unless an admin approves it.
  - Over-limit attempts are visible to the user with the resulting balance and the limit.

### FR-005 — Credit hold for late dealers and owner override

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want new releases blocked when a dealer is more than the allowed number of days late, while still allowing an explicit approval.
- **Acceptance criteria:**
  - The late threshold is configurable (`holdDays`, default 60).
  - A dealer whose oldest unpaid delivery exceeds the threshold is on credit hold.
  - Staff cannot create a new credit sale for a dealer on hold.
  - An owner or editor can approve a specific release; the approval is stored and shown on the transaction.
  - The server enforces the rule, not only the browser.

### FR-006 — Debit and credit adjustments

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want to add a charge or a credit that is not a sale, payment or return so I can correct balances without changing stock.
- **Acceptance criteria:**
  - An adjustment has a dealer, a direction (`debit` or `credit`), amount, date, optional due date, reason and note.
  - A debit adjustment increases the balance and behaves like a charge for FIFO and aging.
  - A credit adjustment reduces the balance.
  - The server assigns a unique number in the form `ADJ-00001`.
  - Only owners and editors can create or edit an adjustment.
  - A missing or invalid direction is rejected with a clear message.
  - Adjustments appear in the ledger, dealer statement, receipt and reports with the correct sign.

### FR-007 — Write off bad debt

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want to remove an amount that will never be collected while keeping a full audit record.
- **Acceptance criteria:**
  - A write-off has a dealer, amount, date, reason and optional note.
  - A reason is mandatory.
  - A write-off reduces the dealer balance and is treated as credit in FIFO allocation.
  - The server assigns a unique number in the form `WO-00001`.
  - Only owners and editors can create or edit a write-off.
  - Write-offs appear in the ledger, dealer statement, receipt, dashboard and reports.
  - Voiding a write-off restores its effect on the balance.

### FR-008 — Accounts-receivable aging report

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want receivables grouped into current, 1–30, 31–60, 61–90 and 90+ days so I can prioritise collection.
- **Acceptance criteria:**
  - The report supports an as-of date and optional dealer filter.
  - Each open charge is placed in exactly one aging bucket based on its due date and unpaid remainder.
  - The report totals each bucket and reconciles to the dealer's current balance.
  - Results can be exported to CSV and printed.

### FR-009 — Printable statement of account

- **Priority:** P1
- **Status:** Implemented
- **User story:** As store staff, I want a formal statement showing every charge, credit and running balance for a period so I can send it to a dealer.
- **Acceptance criteria:**
  - The statement has an opening balance, dated transactions, running balance and a closing balance.
  - It supports a date range and shows due dates for unpaid charges.
  - It can be printed or copied as text.
  - It includes the store name, address and contact details.

### FR-010 — Installment and payment plans

- **Priority:** P2
- **Status:** Implemented
- **User story:** As the owner, I want to split a large receivable into scheduled installments so a dealer can pay over time.
- **Acceptance criteria:**
  - A charge can be linked to a plan with a number of installments, frequency and start date.
  - Each installment has a due date and amount.
  - The plan shows paid, due and remaining amounts.
  - Missed installments feed the aging and credit-hold rules.

### FR-011 — Late fees and interest

- **Priority:** P2
- **Status:** Implemented
- **User story:** As the owner, I want to charge a late fee or interest on overdue balances according to a configurable policy.
- **Acceptance criteria:**
  - A policy defines the rate, grace period and compounding method.
  - Fees are previewed before posting and require confirmation.
  - Posting creates a debit adjustment linked to the source charge.
  - Fees are reported separately from sales.

### FR-012 — Dealer credit rating and payment history

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want a simple rating and payment history per dealer so I can decide whether to extend more credit.
- **Acceptance criteria:**
  - Each dealer shows an A–D rating, on-time percentage, average days to pay and worst delay.
  - The last six months of credit taken, paid and returned are shown.
  - A log records credit-limit changes with who changed them and when.
  - The calculations ignore voided transactions.

---

## B. Inventory and procurement

### FR-013 — Stock in, stock out and stock adjustment

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want to increase or decrease stock with a reason so inventory stays accurate and explainable.
- **Acceptance criteria:**
  - Stock changes through a dedicated endpoint, never by editing a product's stock field.
  - Each change stores date, quantity, reason, optional note and the person who made it.
  - Sales reduce stock; restocked returns increase stock.
  - Adjustments and write-offs do not change stock.

### FR-014 — Stock count

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want a periodic physical count so I can find missing or damaged stock.
- **Acceptance criteria:**
  - A count shows every product and its system quantity.
  - The user enters counted quantities and differences are calculated.
  - Applying a count creates stock movement records with a variance reason.
  - A reminder appears when a monthly count is overdue.

### FR-015 — Low-stock and reorder alerts

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to be warned before a product runs out so I can reorder in time.
- **Acceptance criteria:**
  - Each product can have a reorder level.
  - Products at or below the reorder level appear in a low-stock panel and dashboard notice.
  - Reserved quantities are considered when deciding whether stock is available.
  - The alert clears when stock is replenished above the level.

### FR-016 — Reserve stock for open orders

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want open online orders to hold stock so two dealers are not promised the same units.
- **Acceptance criteria:**
  - Quantities on orders in `new`, `preparing` and `ready` count as reserved.
  - Released, cancelled and voided orders do not reserve stock.
  - Available quantity equals stock on hand minus reserved quantity.
  - The dealer portal marks a product unavailable when all stock is reserved.
  - Releasing an order excludes that same order from the reservation check.

### FR-017 — Backorder support

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want an order to be accepted with a backorder flag when stock is short so the dealer is not blocked.
- **Acceptance criteria:**
  - An order stores `backorder` and a `shortItems` list.
  - Each short item shows the product, requested quantity and available quantity.
  - The order screen clearly labels a backorder and lists the short items.
  - Releasing a short order requires stock or the `allowNegativeStock` setting.

### FR-018 — Negative-stock guard

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want the app to stop stock going below zero unless I explicitly allow backorders.
- **Acceptance criteria:**
  - By default, a stock change that would make stock negative is rejected with `409 insufficient_stock`.
  - The error names the product, current stock and requested quantity.
  - The setting `allowNegativeStock` can be enabled by an owner or editor.
  - When enabled, negative stock is allowed and shown in the interface.
  - The product edit form can never overwrite stock directly.

### FR-019 — Supplier registry

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want a list of suppliers with contacts and terms so purchasing is organised.
- **Acceptance criteria:**
  - A supplier has a name, contact person, phone, address, payment terms and notes.
  - Suppliers can be archived but not deleted while referenced by a purchase order.
  - Supplier records are searchable and role-protected.

### FR-020 — Purchase orders

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to order stock from a supplier and track what is still outstanding.
- **Acceptance criteria:**
  - A purchase order has a supplier, order date, expected date, lines, quantities and cost prices.
  - The server assigns a sequential `SPO-` purchase number. Online orders already use `PO-`, so the two never collide.
  - Statuses cover draft, ordered, partially received, received and cancelled.
  - Totals and outstanding quantities are shown.

### FR-021 — Goods received and supplier invoices

- **Priority:** P1
- **Status:** Implemented
- **User story:** As store staff, I want to receive goods against a purchase order so stock and payables update.
- **Acceptance criteria:**
  - A receipt records received quantities, date and reference.
  - Receiving increases stock and updates cost prices.
  - Partial receipts are supported and outstanding quantities reduce.
  - A supplier invoice can be linked with amount and due date.

### FR-022 — Product cost price

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want to store what I paid for each product so I can measure gross profit.
- **Acceptance criteria:**
  - A product has an optional cost price.
  - Only owners and editors can change the cost.
  - Staff edits cannot overwrite an existing cost.
  - The product list shows cost, profit per piece and margin percentage.
  - New sale and return lines snapshot the current cost so historical profit does not change when cost changes.

### FR-023 — Costing method (weighted average or FIFO)

- **Priority:** P2
- **Status:** Implemented
- **User story:** As the owner, I want cost of goods sold calculated consistently when purchase costs change.
- **Acceptance criteria:**
  - The store chooses weighted-average or FIFO costing.
  - Receipts update the cost layers or average.
  - Sales consume cost from the chosen method.
  - Profit reports disclose the method used.

### FR-024 — Batch, lot and expiry tracking

- **Priority:** P2
- **Status:** Implemented
- **User story:** As the owner, I want to track batches and expiry dates for products that can expire.
- **Acceptance criteria:**
  - A product can be marked as batch-tracked.
  - Receipts create batch records with quantity and expiry.
  - Sales consume batches according to the configured rule.
  - Near-expiry and expired stock reports are available.

---

## C. Orders and fulfillment

### FR-025 — Dealer self-service ordering

- **Priority:** P0
- **Status:** Implemented
- **User story:** As a dealer, I want to order from the catalog from my phone so I can collect without waiting for a salesperson.
- **Acceptance criteria:**
  - A dealer sees only their own price and available catalog.
  - The cart persists on the device until submitted.
  - An order can include multiple products, quantities, a pickup date and a note.
  - The dealer cannot see stock counts, cost prices or other dealers.
  - A dealer can cancel only an order that is still new.

### FR-026 — Server-side order pricing

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want order prices calculated by the server so a dealer cannot change them.
- **Acceptance criteria:**
  - Prices come from the catalog, promo rules and the dealer's discount.
  - Client-supplied prices are ignored.
  - Duplicate product lines are merged.
  - Invalid products, quantities or pickup dates are rejected.
  - Order totals and discount snapshots are stored.

### FR-027 — Order status workflow

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want to move an order through preparing and ready so the dealer knows when to collect.
- **Acceptance criteria:**
  - Allowed statuses are `new`, `preparing`, `ready`, `released` and `cancelled`.
  - Every change appends to the status history with time and user.
  - The dealer sees each status change.
  - Invalid or backwards transitions are rejected by the server.

### FR-028 — Release an order as a credit sale

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want to release a ready order as a credit sale in one step so I do not retype prices and items.
- **Acceptance criteria:**
  - The release form is prefilled with the order's items, discounts and note.
  - The resulting sale gets the normal `DR-` number and validation.
  - The order stores the sale ID and sale number and becomes `released`.
  - Stock is reduced atomically with the sale.
  - Optional payment-on-release records a linked payment.

### FR-029 — Pickup scheduling

- **Priority:** P1
- **Status:** Implemented
- **User story:** As a dealer, I want to choose a pickup date so the store can prepare my order in time.
- **Acceptance criteria:**
  - A pickup date can be set when ordering.
  - Past pickup dates are rejected.
  - The order list and order screen show the pickup date.
  - The store can leave the date blank for "anytime".

### FR-030 — Flag credit holds and over-limit orders

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want to see credit risk on an incoming order before releasing it.
- **Acceptance criteria:**
  - New orders store `creditHold` when the dealer is over the late threshold.
  - New orders store `overLimit` when the amount would exceed the dealer's credit limit.
  - The order screen explains the flag and the required approval.
  - Releasing an over-limit or hold order still follows the normal approval rules.

### FR-031 — Flag stock availability on orders

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want an order to show which items cannot be filled so I can contact the dealer.
- **Acceptance criteria:**
  - The server computes availability using stock minus other open orders.
  - Short items are stored on the order and shown before release.
  - The portal marks reserved-out products as unavailable.
  - The short list includes product, requested quantity and available quantity.

### FR-032 — Printable pick list and packing list

- **Priority:** P1
- **Status:** Planned
- **User story:** As store staff, I want a printable pick list so I can gather items accurately.
- **Acceptance criteria:**
  - The pick list groups items by product and shows quantities.
  - It shows the order number, dealer, pickup date and notes.
  - A packing list version can be included with the delivery.
  - Printing does not change the order status.

### FR-033 — Delivery and logistics tracking

- **Priority:** P2
- **Status:** Implemented
- **User story:** As the owner, I want to record who delivered an order and when so responsibility is clear.
- **Acceptance criteria:**
  - A released order can record a driver, vehicle, delivery date and remarks.
  - The dealer can see the delivery details.
  - Delivery status is separate from payment status.
  - Delivery records appear in the order timeline.

### FR-034 — Order cancellation with audit trail

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want to cancel an order with a reason so stock reservations are released and the audit trail is complete.
- **Acceptance criteria:**
  - Cancelling requires a status change to `cancelled`.
  - A reason can be recorded.
  - Cancelled orders no longer reserve stock.
  - The cancellation appears in the timeline and the activity log.
  - A released order cannot be cancelled; its sale must be voided instead.

---

## D. Pricing and catalog

### FR-035 — Store, dealer and product discount levels

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want a default, dealer-specific and product-specific discount so pricing follows my catalog.
- **Acceptance criteria:**
  - The store default discount is configurable.
  - A dealer can have a different discount.
  - A product can override the discount, including zero for net-priced items.
  - The most specific applicable discount wins.
  - Mixed discounts are recorded per line and shown correctly.

### FR-036 — Promo pricing with date windows

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want a promo price that applies only within its dates so I can run time-limited offers.
- **Acceptance criteria:**
  - A promo has a price, start date, end date and a "no discount on top" flag.
  - Promos apply to sales and orders dated inside the window.
  - Expired and future promos are ignored for pricing.
  - Promo lines are marked on receipts and orders.

### FR-037 — Bulk catalog update

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to paste a new price list from Excel or CSV so updating many products is fast.
- **Acceptance criteria:**
  - Parsed rows show new products, price changes, promos and products missing from the sheet.
  - The user previews all changes before applying them.
  - Dealer prices are recalculated from the store discount.
  - Every SRP change is appended to the product price history.
  - The update is atomic and audited.

### FR-038 — Price history

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to see how a product's price changed so I can explain old invoices.
- **Acceptance criteria:**
  - Each price change stores the old and new price, time and source.
  - The product screen shows the history newest first.
  - Historical sale lines keep their original price.

### FR-039 — Volume and tier pricing

- **Priority:** P2
- **Status:** Planned
- **User story:** As the owner, I want lower prices for larger quantities so I can encourage bigger orders.
- **Acceptance criteria:**
  - A product can have quantity tiers with price or discount.
  - The best applicable tier is applied automatically.
  - The applied tier is shown on the order and receipt.
  - Tiers respect start and end dates.

### FR-040 — Quotations and price offers

- **Priority:** P2
- **Status:** Planned
- **User story:** As store staff, I want to send a quotation without affecting stock or the dealer balance.
- **Acceptance criteria:**
  - A quotation has items, prices, validity dates and terms.
  - It does not reserve stock or create a receivable.
  - It can be converted into an order or sale.
  - Expired quotations are clearly marked.

---

## E. Returns and adjustments

### FR-041 — Returns with optional restocking

- **Priority:** P0
- **Status:** Implemented
- **User story:** As store staff, I want to record returned items and choose whether they go back to stock.
- **Acceptance criteria:**
  - A return has dealer, date, items, amount and a restock flag.
  - The server assigns a unique number in the form `RT-00001`.
  - The dealer balance decreases by the return amount.
  - Restocked items increase stock; damaged items can stay out.
  - The return appears on a return slip and in reports.

### FR-042 — Sale-linked return limits

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want a return linked to a delivery to be capped at what was actually delivered and not already returned.
- **Acceptance criteria:**
  - A return can reference a delivery receipt.
  - The server verifies the delivery exists, belongs to the same dealer and is not voided.
  - For each product, the return quantity cannot exceed delivered minus previously returned quantity.
  - Edits exclude the return being edited from the already-returned total.
  - The browser caps quantity controls and shows the maximum.
  - Over-returns are rejected with a clear message.

### FR-043 — Return reasons and item condition

- **Priority:** P1
- **Status:** Planned
- **User story:** As the owner, I want to know why items were returned and in what condition so I can improve operations.
- **Acceptance criteria:**
  - Each return line records a reason and condition code.
  - Condition determines whether the item can be restocked.
  - Reason and condition appear in reports.
  - Common reasons are configurable.

### FR-044 — Supplier returns and RMA

- **Priority:** P2
- **Status:** Planned
- **User story:** As the owner, I want to return defective stock to a supplier and track the credit.
- **Acceptance criteria:**
  - A supplier return references a supplier, products and quantities.
  - Stock is reduced with a supplier-return reason.
  - A supplier credit or replacement can be recorded.
  - The return is tracked until closed.

### FR-045 — Damage and loss adjustments

- **Priority:** P1
- **Status:** Partial
- **User story:** As store staff, I want to remove damaged or lost stock with a reason so inventory matches reality.
- **Acceptance criteria:**
  - Stock can be reduced with reasons such as damage, expiry, theft or count variance.
  - Each adjustment stores who, when, quantity and note.
  - The value of the loss can be calculated from cost.
  - **Gap:** reasons and movement records exist, but loss valuation and a dedicated damage/loss report are not yet built.

---

## F. Reporting and analytics

### FR-046 — Sales and collections by period

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want sales, returns and collections for a chosen period so I can see business performance.
- **Acceptance criteria:**
  - The report accepts a from date and to date with presets.
  - It totals credit sales, discounts, returns, collections, adjustments and write-offs.
  - Voided transactions are excluded.
  - Results can be exported to CSV.

### FR-047 — Product performance report

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want to know which products sell and which are returned so I can manage the catalog.
- **Acceptance criteria:**
  - The report shows quantity sold, quantity returned, sales amount, cost and profit per product.
  - Returns reduce the reported quantity and profit.
  - Products with no movement are omitted.
  - Results can be exported to CSV.

### FR-048 — Dealer performance report

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want net sales, payments and current balance per dealer so I can compare accounts.
- **Acceptance criteria:**
  - The report shows each dealer's net sales, payments, write-offs and current balance.
  - It reconciles to the dealer ledger.
  - It can be exported to CSV.

### FR-049 — Payment method report

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want collections grouped by payment method so I can reconcile cash, GCash, bank and checks.
- **Acceptance criteria:**
  - Payments are grouped by method for the selected period.
  - Voided payments are excluded.
  - Totals can be exported to CSV.

### FR-050 — Gross-profit reporting

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want gross profit by product and period so I know which items actually make money.
- **Acceptance criteria:**
  - Sale lines use the cost snapshot stored when the sale was created.
  - If no snapshot exists, the product's current cost is used.
  - Returns reverse the original cost and profit.
  - The report shows cost of goods sold, gross profit and margin.
  - Products without a cost show no profit figure rather than a misleading zero.

### FR-051 — Accounts-receivable aging export

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the accountant, I want an aging export with dealer and bucket totals so I can post and review receivables.
- **Acceptance criteria:**
  - The export lists each open charge with due date, age, remaining amount and bucket.
  - Dealer subtotals and a grand total are included.
  - The as-of date is recorded in the file.
  - The export reconciles to the sum of dealer balances.

### FR-052 — Adjustment and write-off reporting

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want adjustments and write-offs reported separately so discounts and bad debt are visible.
- **Acceptance criteria:**
  - The period report totals debit adjustments, credit adjustments and write-offs separately.
  - Dealer rows include write-offs.
  - The report CSV includes the adjustment and write-off sections.
  - The dashboard shows write-offs as a KPI.

### FR-053 — Dashboard KPIs and trend chart

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want a quick overview of receivables, sales, collections and risk so I can act on exceptions.
- **Acceptance criteria:**
  - The dashboard shows balance, overdue, sales, collections and write-offs.
  - It shows a 12-month sales-versus-collections chart.
  - It surfaces credit holds, missing limits, low stock and backup reminders.
  - Values exclude voided records and update live.

---

## G. Security, users and audit

### FR-054 — Role-based access control

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want staff to have only the permissions they need so mistakes and fraud are limited.
- **Acceptance criteria:**
  - Roles are owner, editor, staff, viewer and dealer portal.
  - The server enforces permissions for every write endpoint.
  - Staff can edit or void only records they created today.
  - Viewers cannot change anything.
  - Only owners can manage team accounts.

### FR-055 — Dealer data isolation

- **Priority:** P0
- **Status:** Implemented
- **User story:** As a dealer, I want to see only my own records so other dealers' business stays private.
- **Acceptance criteria:**
  - A portal account is linked to exactly one dealer.
  - The API returns only that dealer's documents and orders.
  - Staff IDs and internal notes are hidden.
  - Cost prices and stock counts are never returned to the portal.

### FR-056 — Self-service password change

- **Priority:** P0
- **Status:** Implemented
- **User story:** As a user, I want to change my password so I can keep my account secure.
- **Acceptance criteria:**
  - The user must provide the current password.
  - The new password must meet the minimum length and complexity.
  - Sessions remain valid after the change.
  - The change is recorded in the activity log.

### FR-057 — Password reset

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to reset a forgotten password for a team member or dealer.
- **Acceptance criteria:**
  - An owner can set a new password from the team screen.
  - A CLI script can reset any account, including the owner.
  - Resetting does not reveal the old password.
  - The reset is audited.

### FR-058 — Activity log

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want an audit trail of sign-ins and changes so I can investigate problems.
- **Acceptance criteria:**
  - Every create, update, delete, restore, stock change, login and password change is recorded.
  - Each entry has time, user, action, collection, document ID and a short detail.
  - Only admins can read the log.
  - The log is append-only from the application.

### FR-059 — Two-factor authentication

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want a second factor for admin accounts so a stolen password is not enough.
- **Acceptance criteria:**
  - Admins can enrol a TOTP authenticator.
  - Recovery codes are issued once and stored hashed.
  - Login requires the second factor after the password.
  - Enrolment, disablement and recovery are audited.
  - A policy can require 2FA for owner and editor roles.

### FR-060 — Login throttling and session expiry

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want brute-force protection and session expiry so accounts are harder to take over.
- **Acceptance criteria:**
  - Repeated failed logins are throttled per account and address.
  - Sessions expire after 30 days and are refreshed on activity.
  - Disabling an account invalidates its sessions immediately.
  - Cookies are HTTP-only, same-site and secure when configured.

### FR-061 — Cost-price privacy

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want cost prices hidden from staff and dealers so margins stay confidential.
- **Acceptance criteria:**
  - Only owners and editors can create or change a product cost.
  - Non-admin edits preserve the existing cost.
  - Dealer portal product responses omit cost, stock, dealer price and margin.
  - Cost is included in admin reports and full backups only.

---

## H. Backup and operations

### FR-062 — Automatic daily database backup

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want a daily copy of the database so a mistake or disk failure does not destroy the ledger.
- **Acceptance criteria:**
  - A consistent SQLite copy is written once per day.
  - Backups are named with the business date.
  - The number kept is configurable with `BACKUP_KEEP` (default 30).
  - Older backups are pruned.
  - A failure is logged without stopping the server.

### FR-063 — Portable JSON backup and restore

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want a readable backup file I can move to another device or import into a new install.
- **Acceptance criteria:**
  - The download contains all document collections and settings.
  - The file identifies the application and export time.
  - Restore accepts a matching file and rejects unrelated JSON.
  - Restore is admin-only and reports the number of records restored.
  - A dry-run summary is shown before restoring.

### FR-064 — Full backup including accounts and photos

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want one backup that also contains team accounts and product photos so a new server can be restored completely.
- **Acceptance criteria:**
  - The full backup contains all collections, users with password hashes, and photos as base64.
  - Only admins can download it.
  - Missing photo files do not abort the backup; the entry carries a null payload.
  - The file includes an application marker and version.

### FR-065 — Full restore in one request

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want to restore a full backup without manually recreating accounts or photos.
- **Acceptance criteria:**
  - The restore endpoint accepts the full backup object or `{ backup, replace }`.
  - With `replace`, collections present in the backup are replaced; other collections are kept.
  - Users are upserted and photos are written back to the uploads folder.
  - Invalid files and unknown collections are ignored or rejected safely.
  - The restore is transactional for documents and audited.
  - A large upload limit is applied only to the restore endpoint.

### FR-066 — Offsite backup hook

- **Priority:** P0
- **Status:** Implemented
- **User story:** As the owner, I want each daily backup copied off the server automatically so a lost server does not mean lost data.
- **Acceptance criteria:**
  - `BACKUP_SYNC_CMD` optionally runs after a successful daily backup.
  - The finished backup path is passed as `BACKUP_FILE`.
  - The command has a bounded timeout.
  - Failure is logged and does not delete the local backup.
  - No command means the feature is silently off.

### FR-067 — Backup verification and monitoring

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to know whether backups are actually usable so I am not surprised during a recovery.
- **Acceptance criteria:**
  - The app records the last successful backup time and size.
  - The dashboard warns when the last backup is older than seven days.
  - A verification job can open the backup and run `PRAGMA integrity_check`.
  - An alert is raised when a backup or offsite sync fails.

---

## I. Platform and integrations

### FR-068 — Multiple branches and store segregation

- **Priority:** P2
- **Status:** Planned
- **User story:** As the owner of several branches, I want each branch's dealers, stock and reports separated while I see consolidated totals.
- **Acceptance criteria:**
  - Each user is assigned to one or more branches.
  - Dealers, products and transactions belong to a branch.
  - Staff see only their branch; owners can switch or consolidate.
  - Stock transfers between branches are recorded.
  - Reports support branch and consolidated views.

### FR-069 — Tax and BIR-ready documents

- **Priority:** P2
- **Status:** Implemented
- **User story:** As the owner, I want tax fields and official document numbering so receipts can meet local requirements.
- **Acceptance criteria:**
  - The store records TIN, VAT registration and business permit details.
  - Products can be marked VAT-exempt or zero-rated.
  - Sales show VATable sales, VAT amount and total.
  - Document series can be registered and are gapless.
  - **Note:** the app supplies the fields and numbering only. Official status comes from BIR registration and accreditation, so receipts say they are not official until a series is registered.
  - Reports provide a tax summary for filing.

### FR-070 — Import, barcode and accounting integrations

- **Priority:** P2
- **Status:** Partial
- **User story:** As the owner, I want to import master data and connect the ledger to other tools so I do not double-enter information.
- **Acceptance criteria:**
  - Dealers and products can be imported from CSV with a preview and validation errors.
  - Products can carry a barcode and be found by scanning.
  - A documented read-only API or webhook exposes sales, payments and balances to accounting tools.
  - Exports use stable IDs and ISO dates.
  - **Gap:** catalog paste-import, CSV exports and the internal JSON API exist; dealer import, barcode scanning and a documented external API are not yet built.

---

## J. Collections and controls

### FR-071 — Automated dealer payment reminders

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want dealers reminded automatically before and after a due date so I do not have to copy and send statements by hand.
- **Acceptance criteria:**
  - A reminder schedule can be configured, for example 3 days before due, on the due date and 7 days overdue.
  - Reminders can be sent by SMS or email through a configurable provider, using the dealer's contact details.
  - The message template includes the dealer name, amount due, due date and store contact details.
  - Dealers can be opted out individually, and no reminder is sent for fully paid or voided charges.
  - Every reminder is logged with channel, time and delivery result, and failures are visible to staff.

### FR-072 — Post-dated and bounced checks

- **Priority:** P1
- **Status:** Implemented
- **User story:** As store staff, I want to track post-dated checks and reverse bounced ones so the dealer's balance reflects money actually received.
- **Acceptance criteria:**
  - A check payment records bank, check number, check date and amount.
  - A post-dated check is held as pending and does not reduce the balance until its check date or until it is marked cleared.
  - A list shows checks due for deposit by date.
  - Marking a check as bounced reverses the payment, restores the charges it settled, and can post an optional bounce fee as a debit adjustment.
  - Bounced checks count against the dealer's credit rating and are shown in the activity log.

### FR-073 — Period close and lock

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to close a month so nobody can change transactions that have already been reported.
- **Acceptance criteria:**
  - An admin can close a period up to a chosen date.
  - The API rejects creating, editing or voiding transactions dated in a closed period.
  - Corrections to a closed period are posted as adjustments dated in the open period.
  - Only an admin can reopen a period, with a required reason, and the reopen is logged.
  - Reports show which periods are closed.

### FR-074 — Dealer credit application and limit review

- **Priority:** P2
- **Status:** Implemented
- **User story:** As the owner, I want new dealers to apply for credit and existing limits to be reviewed on a schedule so credit is extended deliberately.
- **Acceptance criteria:**
  - A credit application records the requested limit, references and supporting documents.
  - Applications move through submitted, approved and rejected states, with the approver and date recorded.
  - An approved application sets the dealer's credit limit and logs the change under FR-012.
  - Each dealer has a next-review date, and dealers due for review are listed for the owner.
  - A review suggests a limit based on the dealer's rating and payment history, which the owner can accept or change.

---

## K. Dealer relationships (CRM)

### FR-075 — Dealer CRM: prospects, contact log and follow-ups

- **Priority:** P1
- **Status:** Implemented
- **User story:** As store staff, I want to track prospects and every call, visit and message with a dealer, with follow-up reminders, so recruiting and collection conversations don't get lost.
- **Acceptance criteria:**
  - A dealer record holds personal details (first, middle and last name, gender (male or female), mobile, email, Messenger link, birthday, area, full address), source, referrer, tags and a stage: new lead, contacted, interested, dealer or lost.
  - Prospects can be added without credit terms and become dealers automatically on their first credit sale; every stage change is kept in a stage history.
  - Staff can log a call, visit, message, meeting or note with an outcome, notes and an optional follow-up date.
  - Open follow-ups due within seven days appear on the overview; overdue ones are highlighted and can be marked done.
  - Marking a dealer as reminded on the collection list also logs a contact.
  - The dealer list filters by stage and tag and shows the next follow-up; the dealer CSV export includes the CRM fields.
  - Staff can mark anyone's follow-up done but can only edit their own entries; only the owner or an editor can delete entries.
  - Dealer portal accounts never see stages, tags or the contact log.

---

## L. Field collections, privacy and growth

### FR-076 — Dealer upload of proof of payment

- **Priority:** P1
- **Status:** Implemented
- **User story:** As a dealer, I want to upload my GCash, Maya or bank transfer receipt in the portal so the store records my payment without me having to send screenshots over chat.
- **Acceptance criteria:**
  - In the portal, a dealer can submit the amount, payment method, reference number, date paid and one or more photos of the receipt.
  - Submissions do not change the balance; they appear in a staff verification queue showing the pending count.
  - Staff can approve a submission, which records a payment applied oldest-delivery-first and links the photos, or reject it with a reason the dealer can see.
  - The app warns when a reference number has already been used on another payment or submission.
  - The dealer sees each submission's status: pending, approved or rejected.
  - Uploaded receipts are visible only to that dealer and to store staff.

### FR-077 — Collector routes and daily remittance

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want each collector to have an assigned route and to hand over what they collected each day so I can see right away when cash goes missing.
- **Acceptance criteria:**
  - A user can be marked as a collector, and dealers or areas can be assigned to a collector.
  - Each collector gets a daily list of their dealers who are overdue or due soon, in route order, with balances and phone numbers.
  - Payments recorded by a collector are tagged with that collector.
  - At the end of the day, the collector submits a remittance with cash counted and checks handed over; the app compares it with the payments recorded and shows the difference.
  - A remittance with a shortage or overage needs owner or editor approval with a note, and every difference is logged per collector.
  - A report shows remittances, differences and collection rates by collector and period.

### FR-078 — Personal data and consent (Philippine Data Privacy Act of 2012)

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to handle dealers' personal information as the Data Privacy Act (RA 10173) requires so the business stays compliant and dealers can trust it.
- **Acceptance criteria:**
  - Each dealer and prospect record stores consent: date, how it was given (signed form, portal, verbal), the privacy notice version, and who recorded it.
  - The privacy notice text is configurable in Store settings and is shown in the portal for the dealer to accept.
  - The owner can export everything held about one dealer (profile, contact log, transactions, uploads) as a file.
  - A lost prospect, or a dealer with no balance and no transactions inside the retention period, can be anonymised on request; financial records needed by law are kept with personal fields removed.
  - Opening a dealer profile, exporting personal data and anonymising are written to the activity log.
  - Personal fields such as name parts, gender, birthday, full address and contact notes are hidden from viewer accounts.

### FR-079 — Daily cash close

- **Priority:** P1
- **Status:** Implemented
- **User story:** As the owner, I want to close each business day by counting money on hand against what the app recorded so mistakes and losses are caught the same day.
- **Acceptance criteria:**
  - For a chosen day, the app totals payments recorded by method: cash, GCash, Maya, bank transfer, check and other.
  - Staff enter the counted or confirmed amount for each method; the app shows the difference per method and overall.
  - Closing the day requires a note when there is a difference and records who closed it and when.
  - After a day is closed, payments dated that day cannot be added, edited or voided except by an owner who reopens the day with a reason.
  - A report lists closed days, totals, differences and who closed them; days not yet closed are flagged on the overview.
  - Collector remittances (FR-077) for the day are included in the cash count.

### FR-080 — Dealer disputes

- **Priority:** P2
- **Status:** Implemented
- **User story:** As a dealer, I want to flag a charge I believe is wrong so it is reviewed instead of counting against me while it is being checked.
- **Acceptance criteria:**
  - From the portal, a dealer can dispute a charge with a reason (not received, wrong quantity, wrong price, other), a disputed amount, a note and an optional photo.
  - Staff can open a dispute on a dealer's behalf.
  - While a dispute is open, the disputed amount is shown separately and excluded from overdue, credit-hold and aging calculations.
  - Staff resolve a dispute as rejected or accepted; acceptance posts a credit adjustment or return linked to the charge.
  - The dealer sees the status and resolution, and every step is logged.
  - A report lists open disputes and how long each has been open.

### FR-081 — Recruiter network and incentives

- **Priority:** P2
- **Status:** Planned
- **User story:** As the owner, I want to see which dealers recruited which, and how their recruits perform, so I can reward recruiters who bring in good payers.
- **Acceptance criteria:**
  - A dealer can be linked to the dealer who recruited them; circular links are rejected.
  - The dealer page shows the recruiter and the dealers they recruited; a tree view shows the network up to a set depth.
  - A report shows, per recruiter and period, the number of recruits, their sales, their collections and their on-time payment rate.
  - Incentive rules (for example a percentage of recruits' collected sales, or a fixed amount per active recruit) can be set up and previewed.
  - Calculated incentives can be exported or posted as a credit adjustment to the recruiter's account after owner approval.
  - Payroll and cash payouts of incentives stay out of scope.

### FR-082 — Sales targets

- **Priority:** P2
- **Status:** Partial
- **User story:** As the owner, I want to set monthly sales and collection targets for dealers and areas so I can track progress and spot dealers who have gone quiet.
- **Acceptance criteria:**
  - Monthly targets for net sales and collections can be set per dealer, per area or store-wide, and copied from one month to the next.
  - The dealer page, the dealers list and the reports show progress as a percentage of target for the current month.
  - The overview lists dealers below a set percentage of target near month-end.
  - Dealers who have not ordered within a set number of days (default 60) are flagged as inactive and can be filtered.
  - Target history is kept so past months can be compared.
  - **Gap:** store-wide monthly targets, progress on the Dashboard tab and the 60-day inactive-dealer list are built; per-dealer and per-area targets are not.

---

## M. Catalog media, approvals and field use

### FR-083 — Product pictures from internet links

- **Priority:** P1
- **Status:** Implemented
- **User story:** As store staff, I want to add a product photo from a link on the internet so I don't have to save and re-upload pictures from the supplier's website.
- **Acceptance criteria:**
  - The product form accepts a picture link or a product page link; for a page, the page's preview picture (`og:image`) is used.
  - "Find online" opens an image search for the product name and code in a new tab.
  - The picture is downloaded by the server, stored like an uploaded photo and shown before saving; pasting a link into the form starts the download.
  - The catalog update accepts an Image column and downloads pictures for products with no photo or a changed link, reporting any that fail.
  - Only http(s) links on standard ports to public addresses are fetched, including after redirects; downloads are limited to 8 MB and 12 seconds and must be a real JPG, PNG, WebP or GIF.
  - Viewer and dealer accounts cannot fetch pictures; each download is in the activity log with its source link.
  - Pictures never saved on a record are deleted after 24 hours (PR-11).

### FR-084 — Approval requests for credit-hold and over-limit sales

- **Priority:** P1
- **Status:** Implemented
- **User story:** As store staff, I want to send a sale that is blocked by a credit hold or credit limit to the owner for approval instead of being stopped, so the dealer isn't kept waiting.
- **Acceptance criteria:**
  - When a staff sale is blocked, staff can submit it as an approval request with a reason; the sale is saved as pending and does not change stock or the balance.
  - Owners and editors see pending requests with the dealer's balance, overdue amount, days late and credit limit, and are alerted when a new one arrives.
  - Approving records the sale exactly as requested, with the approver and time; rejecting requires a reason that the requester sees.
  - A request expires if not decided within a configurable time (default 24 hours) and can be withdrawn by the requester.
  - Every request and decision is in the activity log, and a report lists approvals by approver and dealer.

### FR-085 — Apply a payment to a chosen delivery

- **Priority:** P1
- **Status:** Implemented
- **User story:** As store staff, I want to apply a payment to the delivery the dealer says it is for, so their statement matches what they paid.
- **Acceptance criteria:**
  - Oldest-delivery-first remains the default; staff can instead pick one or more unpaid deliveries and the amount for each.
  - Allocated amounts cannot exceed what is unpaid on a delivery; any remainder follows the oldest-first rule.
  - Balances, aging, statements, credit history and receipts all use the chosen allocation.
  - Voiding or editing the payment releases its allocation.
  - The receipt lists the deliveries the payment was applied to.

### FR-086 — Record payments offline

- **Priority:** P1
- **Status:** Implemented
- **User story:** As a collector working where there is weak or no signal, I want to record payments on my phone and have them sync later so nothing has to be written on paper.
- **Acceptance criteria:**
  - The app can be installed on a phone and opens without a connection, showing the collector's dealers, balances and last-synced time.
  - Payments recorded offline are queued on the device, clearly marked as not yet synced, and sent automatically when the connection returns.
  - Each queued payment has a unique client ID so a retry never records it twice; the server rejects duplicates.
  - If a queued payment conflicts with changes made meanwhile (for example the dealer was archived), it is held for review instead of being lost.
  - Offline data on the device is limited to what the collector needs and is cleared on sign-out.
  - **Note:** installing the app and working offline need the site to be served over HTTPS (or opened on `localhost`).

### FR-087 — Filipino language option

- **Priority:** P2
- **Status:** Planned
- **User story:** As a dealer or staff member, I want to use the app in Filipino so it is easier to understand.
- **Acceptance criteria:**
  - Each user can choose English or Filipino; the dealer portal follows the dealer's choice.
  - All screens, buttons, errors and printed documents are available in both languages.
  - Reminder and statement message templates can be set separately for each language, and each dealer's preferred language is used.
  - Dates and amounts keep the Philippine format in both languages.
  - Untranslated text falls back to English without breaking the layout.

### FR-088 — Detect existing dealers and products

- **Priority:** P1
- **Status:** Implemented
- **User story:** As store staff, I want to see if a dealer or product is already in the ledger while I add it, so I don't create a second record that splits its balance or stock.
- **Acceptance criteria:**
  - While a dealer is entered, the form lists existing dealers with the same mobile number (any format), email or name, and similar names such as a missing middle name or a one-letter typo.
  - While a product is entered, the form lists existing products with the same code or name, and similar names. Different sizes, such as 1L and 2L, don't match.
  - Each match shows details that help tell records apart, is labelled if archived, and can be opened from the form.
  - An exact match can never be saved. The server refuses it from every screen and import, and archived records count. Two different people with one name are told apart by adding a middle name. A similar match only shows a hint.
  - A catalog import skips a duplicate row, carries on with the rest and reports what it skipped.
  - Editing a record only checks the fields that changed, so duplicates from before this rule can still be edited.

---

## Production readiness

These items must be resolved before, or soon after, the application is used with real dealers and money. They are not features, so they are tracked separately from the functional requirements and do not count toward the status summary.

| Priority | Meaning |
|---|---|
| **Blocker** | Must be done before going live. |
| **Soon** | Should be done within the first weeks of a pilot. |

| ID | Item | Priority | Status |
|---|---|---|---|
| PR-01 | Commit, review and tag the current work | Blocker | Partly done: committed on branch production-readiness and tagged; human review pending |
| PR-02 | Fix vulnerable dependencies | Blocker | Done |
| PR-03 | Record a sale and its stock change atomically | Blocker | Done |
| PR-04 | Server-side pricing of credit sales | Blocker | Done |
| PR-05 | HTTPS, secure cookies and security headers | Blocker | Done (code); HTTPS proxy is set up at deployment |
| PR-06 | Data Privacy Act compliance before collecting personal data | Blocker | Done (app tools); notice review, DPO and NPC check are for the business |
| PR-07 | Automated tests for browser business logic, and CI | Soon | Done |
| PR-08 | Verified backups and a tested restore | Soon | Done |
| PR-09 | Performance as data grows | Soon | Done |
| PR-10 | Protection of data on lost phones | Soon | Done |
| PR-11 | Clean up orphaned picture downloads | Soon | Done |
| PR-12 | Pilot rollout plan | Blocker | Open |

### PR-01 — Commit, review and tag the current work

- **Priority:** Blocker
- **Problem:** About 1,600 changed lines sit uncommitted on top of the initial commit, and none of it has been reviewed.
- **Done when:**
  - The work is committed as separate, focused commits (aging and statements, CRM, picture import, offline payments, chosen-delivery payments, approvals, documentation).
  - A second person or an automated review has checked the changes, and findings are resolved.
  - The release is tagged so a deployment can be rolled back.

### PR-02 — Fix vulnerable dependencies

- **Priority:** Blocker
- **Problem:** `npm audit` reports 3 high and 1 moderate vulnerability in `body-parser`, `path-to-regexp` and `qs` (through Express), all of which allow denial of service.
- **Done when:**
  - `npm audit --omit=dev` reports no high or critical issues.
  - All tests pass after the upgrade.
  - The audit runs automatically (see PR-07) so new issues are noticed.

### PR-03 — Record a sale and its stock change atomically

- **Priority:** Blocker
- **Problem:** The sale form saves the sale, then changes stock in a second request. If the second request fails (insufficient stock or a dropped connection), the sale exists without its stock movement. This breaks the Atomicity requirement below.
- **Done when:**
  - Creating, editing or voiding a sale or return, and its stock change, happen in one server transaction; either both are saved or neither is.
  - The insufficient-stock check runs inside that transaction.
  - A test shows that a sale rejected for stock leaves no transaction behind, and a failed request leaves stock unchanged.

### PR-04 — Server-side pricing of credit sales

- **Priority:** Blocker
- **Problem:** Online orders are priced by the server (FR-026), but credit sales recorded by staff are stored with the totals the browser sends. A staff member could record a sale at any price.
- **Done when:**
  - The server recalculates each line from the product's price, promo and the dealer's discount, and recomputes subtotal, discount and total.
  - A price that differs from the calculated one is accepted only from an owner or editor, or with a recorded reason, and is shown as a manual price.
  - Tests cover tampered prices, discounts and totals.

### PR-05 — HTTPS, secure cookies and security headers

- **Priority:** Blocker
- **Problem:** Without HTTPS, passwords and session cookies travel in plain text, and installing the app or working offline is impossible.
- **Done when:**
  - The site is served only over HTTPS through a reverse proxy, and plain HTTP redirects to HTTPS.
  - `COOKIE_SECURE=true` is set, and the server refuses to start in production without it.
  - Responses include a Content-Security-Policy, Strict-Transport-Security and the existing security headers.
  - Deployment steps are written down in the README.

### PR-06 — Data Privacy Act compliance before collecting personal data

- **Priority:** Blocker
- **Problem:** The CRM stores birthdays, addresses and contact notes, but consent, export and anonymisation (FR-078) are not built.
- **Done when:**
  - FR-078 is implemented, or the CRM's personal fields are hidden until it is.
  - A privacy notice is published, and the business has checked whether it must register with the National Privacy Commission.
  - A data breach response contact and procedure are written down.

### PR-07 — Automated tests for browser business logic, and CI

- **Priority:** Soon
- **Problem:** The 27 tests cover only the API. About 2,000 lines of business logic in `public/index.html` (aging, statements, payments, CRM) have no tests in the repository, and nothing runs the tests automatically.
- **Done when:**
  - Settlement, aging, statements and payment allocation are covered by automated tests, ideally by sharing the code in `lib/credit.js` with the browser.
  - A small set of browser tests covers recording a sale, a payment, an offline payment and an approval.
  - Tests and the dependency audit run on every push, and failures block merging.

### PR-08 — Verified backups and a tested restore

- **Priority:** Soon
- **Problem:** Backups are taken daily but never checked (FR-067 is partial).
- **Done when:**
  - FR-067 is implemented: integrity check, last-backup status on the dashboard, and an alert on failure.
  - A full restore onto a fresh server has been carried out and timed, and the steps are written down.
  - At least one backup copy is kept off the server.

### PR-09 — Performance as data grows

- **Priority:** Soon
- **Problem:** Every change makes every open screen reload whole collections, and the server rereads all transactions on each sale or payment. This is fine for a small store but slows down as data grows.
- **Done when:**
  - Live updates send only the changed records, or screens reload only what changed.
  - Dealer balance checks read only that dealer's transactions, using an index.
  - A test with at least 50,000 transactions and 1,000 dealers keeps normal pages under the one-second target.

### PR-10 — Protection of data on lost phones

- **Priority:** Soon
- **Problem:** Offline data on a phone is not encrypted, and sessions last 30 days, so a lost phone exposes dealer balances until the account is disabled.
- **Done when:**
  - Collector sessions are shorter, or require re-entry of a PIN when the app is reopened.
  - An owner can sign a device out remotely, which clears its offline data on next contact.
  - Two-factor authentication (FR-059) is available for owners and editors.

### PR-11 — Clean up orphaned picture downloads

- **Priority:** Soon
- **Problem:** A picture downloaded in the product form and then cancelled is never deleted (known gap in FR-083).
- **Done when:**
  - Uploaded or downloaded pictures not linked to any product after 24 hours are deleted automatically.
  - Deletion is logged and never removes a picture still in use.

### PR-12 — Pilot rollout plan

- **Priority:** Blocker
- **Problem:** The application has not yet been used with real dealers, money and collectors.
- **Done when:**
  - PR-01 to PR-06 are done and one full backup restore has been tested.
  - One store and two or three staff use the app for two to four weeks, alongside the existing records.
  - Balances are compared with the old records each week, and differences are explained.
  - Issues found in the pilot are fixed before wider rollout.

---

### Production readiness results (3 November 2026)

- **PR-02:** `npm audit --omit=dev` reports 0 vulnerabilities (express 4.22.3).
- **PR-03, PR-04:** sales and returns are priced and change stock in one server transaction; manual prices need an owner, an editor or a reason.
- **PR-05:** HTTPS redirect, HSTS and a hash-based Content-Security-Policy when `COOKIE_SECURE=true`; production refuses to start without it. README, "Going live".
- **PR-06:** FR-078 implemented; `docs/PRIVACY.md` covers the business's remaining steps and breach response.
- **PR-07:** 40 Node tests (API and browser logic) and 4 headless-Chrome tests; GitHub Actions runs them with the audit. Branch protection must be turned on in GitHub.
- **PR-08:** backups are verified and alert on failure; a 50,000-transaction ledger backed up and verified in 0.2 s and restored in 0.3 s.
- **PR-09:** with 1,000 dealers and 50,000 transactions, screens switch in 0.06–0.32 s and writes take about 20 ms (README, "Performance"). Opening on a new device takes about 1.8 s.
- **PR-10:** two-step sign-in (FR-059), remote sign-out with offline-data wipe, 7-day staff sessions.
- **PR-11:** unused pictures are removed after 24 hours.
- **Still open:** a human review of the branch (PR-01) and the pilot (PR-12). A full backup restore resets two-step sign-in for restored accounts, because the backup doesn't include authenticator secrets.

## Cross-cutting non-functional requirements

These apply to every functional requirement above.

| Area | Requirement |
|---|---|
| **Server-side enforcement** | Permissions, pricing, stock and credit rules are enforced by the API, not only by the browser. |
| **Atomicity** | A sale and its stock movement succeed or fail together. |
| **Money** | Amounts are stored to two decimal places and rounded consistently with `r2`. |
| **Time** | Business dates use the configured `TZ` (default `Asia/Manila`). |
| **Audit** | Every state change is attributable to a user and a time. |
| **Privacy** | Dealers see only their own data; cost and stock are admin-only. |
| **Accessibility** | Forms have labels, dialogs have roles, and touch targets are usable on a phone. |
| **Performance** | Normal pages respond within one second on a small store dataset. |
| **Recoverability** | A daily backup exists and a full backup can rebuild a server. |

## Test coverage for P0 items

| Requirement | Automated coverage |
|---|---|
| FR-006, FR-007 | `test/api.test.js` — adjustments and write-offs change the balance and are admin-only |
| FR-016, FR-017, FR-030, FR-031 | `test/api.test.js` — online orders reserve stock and flag backorders, credit holds and over-limit orders |
| FR-018 | `test/api.test.js` — stock cannot go below zero unless backorders are allowed |
| FR-022, FR-061 | `test/api.test.js` — product cost is admin-only and is kept for profit reports |
| FR-042 | `test/api.test.js` — returns linked to a delivery cannot exceed what was delivered |
| FR-064, FR-065 | `test/api.test.js` — full backups include accounts and photos and restore in one request |
| FR-066 | `test/api.test.js` — the offsite backup hook receives the finished backup file |
| FR-075 | `test/api.test.js` — stages and contact entries are validated, staff edit limits apply, portal accounts see no CRM data, and a first sale promotes a prospect |
| FR-083 | `test/api.test.js` — private, local and non-web links are refused; redirects, product pages, fake and oversized images and permissions are checked |
| FR-084 | `test/api.test.js` — blocked staff sales become requests that leave stock and balances alone; only owners and editors decide; approval records the sale for the requester; rejection needs a reason; withdraw and expiry |
| FR-085 | `test/api.test.js` — chosen deliveries are validated, paid first with the rest oldest-first, and released when the payment is voided |
| FR-086 | `test/api.test.js` — offline payments are recorded once even when resent, only new payments can be offline, archived-dealer payments are held until an owner or editor confirms |

## Implementation notes

- **Credit rules:** `lib/credit.js` exports `isCharge()`, `txnEffect()` and `dealerStatus()`. A charge is a sale or a debit adjustment; every other transaction type is a credit.
- **Transaction numbers:** `lib/app.js` maps `sale → DR`, `payment → OR`, `return → RT`, `adjustment → ADJ`, `writeoff → WO`.
- **Stock reservation:** open orders (`new`, `preparing`, `ready`) hold quantity. Available quantity is stock minus reserved. Releasing an order excludes that order from the check.
- **Cost snapshot:** sale and return lines store `cost` at the time they are recorded. Reports prefer the snapshot and fall back to the product's current cost.
- **Full backup:** `GET /api/backup/full`; full restore: `POST /api/backup/restore` with a 50 MB JSON limit.
- **Aging and statements:** `agingFor(dealerId, asOf)` in `public/app.js` settles charges FIFO using only transactions dated on or before the as-of date, so each unpaid charge falls in one bucket and buckets − unapplied credit = balance. `periodStatement()` reuses it to show what is unpaid at the end of the period. Both open as printable sheets; the aging report exports CSV with dealer and transaction IDs and ISO dates.
- **QR codes:** `GET /api/qr?data=…&size=…` returns an authenticated PNG (text capped at 600 characters, size clamped to 96–600 px). Receipts, statements, aging reports and the owner summary print a QR code, and dealers and products have printable QR labels. Each code encodes an app deep link such as `#receipt/<id>`, `#statement/<id>`, `#aging[/<dealerId>]`, `#summary`, `#dealer/<id>` or `#product/<id>`; `hashTarget()` parses it and `openDeepLink()` opens the record after the ledger loads. The dealer portal understands the same receipt, statement, order, dealer and product links, so a dealer who scans a receipt sees it in their account.
- **Shared rules:** `lib/credit.js` is served as `/credit.js`, so the server, staff app and portal use one copy of `settle()`, `counts()` and `splitName()`. `counts()` leaves out voided records and post-dated checks until their date.
- **Daily operations:** `lib/ops.js` holds the rules and routes for cash close, remittance, checks, proof of payment, reminders and purchasing; `public/ops.js` holds their screens. New collections: `cashcloses`, `remittances`, `reminders`, `proofs`, `suppliers`, `purchases`.
- **Ledger history:** a transaction can only be voided, never deleted (sample records are the exception). `settings.closedThrough` locks transactions on or before that date; it changes only through `/api/periods/close` and `/api/periods/reopen`. A closed cash day locks that day's payments. A check that bounces inside a locked date is reversed by a debit dated today, so closed books are not rewritten.
- **What is due:** `dueParts()` in `lib/credit.js` turns an open charge into `[{ due, amount }]`, applying its payment plan and leaving out any disputed amount. Overdue, credit hold, aging, reminders and late fees all use it. A disputed amount has its own aging column, so aging still reconciles to the balance.
- **Finance:** `lib/finance.js` holds plans, late fees, costing, lots, delivery, VAT, credit applications and disputes. `stockMoved()` keeps cost layers and lots in step with every stock change. Stock that comes back goes to a `RETURNED` lot for checking, because a sale doesn't record which lot it took.
- **Added beyond this list:** merging duplicates, supplier payments, expenses and net profit, stock locations, barcodes, approval of large voids and discounts (`settings.controls`, default ₱1,000 and 10%), offline sales and returns, a portal statement, thermal receipts, forgotten-password help, phone notifications (`lib/push.js`), system health (`/api/status`), and a general API limit. Offline dealer edits are deliberately not supported: phones don't store personal fields (PR-10), so an offline save could erase them.
- **Reminders:** `REMINDER_WEBHOOK_URL` receives `{ channel, to, message }` as JSON, with `REMINDER_WEBHOOK_TOKEN` as a bearer token. The server runs hourly from 09:00 to 18:00. Each reminder is keyed by dealer, due date and schedule step, so a sent message is never repeated and a failed one is retried.
- **Duplicate checks:** the forms warn as you type with `findDealerMatches()` and `findProductMatches()` in `public/app.js`. `assertUnique()` in `lib/app.js` enforces exact matches using `dealerKeys()` and `productKeys()` in `lib/credit.js`, and answers 409 `duplicate`. Anonymised dealers are skipped. A full restore and `scripts/import-backup.js` copy records as they are and aren't checked.
- **Dealer CRM:** dealers carry `stage`, `stageHistory`, contact fields and `tags`; contact entries live in the `interactions` collection (`dealerId`, `kind`, `date`, `outcome`, `note`, `followUp`, `followUpDone`). The server promotes a prospect to `dealer` inside the same transaction as its first sale.
- **Product pictures from the internet:** `POST /api/assets/fetch { url }` downloads a picture on the server (`lib/fetch-image.js`) and stores it like an upload. Only http(s) on ports 80/443; every resolved address must be public (checked at connect time and on each redirect); 8 MB and 12 s limits; the file must really be JPG, PNG, WebP or GIF; a product page link uses its `og:image`. The source link is kept as `imageLink` and in the activity log. `IMAGE_FETCH_ALLOW_PRIVATE=1` lifts the address check and is for tests only.
- **Settlement:** `settle()` in `lib/credit.js` (the same file is served to the staff app and portal as `/credit.js`, so there is one copy of the rules) processes a dealer's transactions in date order; a payment's `alloc` pays the chosen deliveries first and the rest goes oldest-first. Balances, aging, statements, credit history, receipts and the credit-hold check all use it.
- **Approvals:** requests live in the `approvals` collection and change only through `POST /api/approvals`, `/api/approvals/:id/approve`, `/reject` and `/withdraw`. Approval writes the sale, its stock movement, an optional paid-on-release payment and a linked online order in one database transaction. Pending requests past `settings.approvalHours` (default 24) are marked expired.
- **Offline:** `public/sw.js` caches the app page, script, icons and fonts; `public/shim.js` keeps dealers, transactions, settings and the signed-in account in IndexedDB (`dcl-offline`), queues new payments with `offline.key`, syncs them oldest first and moves refused ones to a review list. The server treats a repeated `offline.key` as already saved. Sign-out clears the device copy and the cached page.
- **Offsite sync:** `BACKUP_SYNC_CMD` receives `BACKUP_FILE` and runs after the daily local backup.

## Out of scope

- Payroll, general ledger, fixed assets and full accounting.
- E-commerce checkout, shipping carriers and payment gateways.
- Native mobile apps; the product is a responsive web app.
- Multi-tenant SaaS billing and subscription management.
