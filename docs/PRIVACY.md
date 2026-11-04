# Privacy and personal data

This guide covers what the Dealer Credit Ledger stores about people, the tools it has for the Data Privacy Act of 2012 (RA 10173), and what the business still has to do itself. It is not legal advice: confirm the points marked **Check** with your adviser or the National Privacy Commission (NPC), because their rules change.

## What the app stores

| Who | What | Who can see it |
|---|---|---|
| Dealers and prospects | Name (first, middle, last), mobile, email, Messenger link, birthday, gender, area and address, source and referrer, tags, notes, consent record | Owner, editors and staff. Viewers see names and balances only. |
| Dealers | Credit sales, payments, returns, adjustments, orders, approval requests | Owner, editors, staff, viewers; each dealer sees only their own in the portal |
| Contact log | Calls, visits, messages and notes about a dealer | Owner, editors and staff (not viewers, not the dealer) |
| Team and portal accounts | Name, username, password hash, role, two-step sign-in secret | Owner |
| Activity log | Who did what and when, including who opened a dealer's profile | Owner and editors |

Data is kept in `DATA_DIR` (database, photos, daily backups). Phones used offline keep a copy of dealers, transactions and store settings, without birthdays, email or addresses; it is wiped on sign-out or when the owner signs that person out everywhere.


Birthday and gender are optional. Birthday is used to confirm who someone is and to greet them; gender is used to address them correctly. Age is never stored: the app works it out from the birthday when it is shown. **Check:** if you have no use for gender, leave it blank, because the Act asks you to collect only what you need.

## Tools in the app

- **Privacy notice:** Store → Privacy. The text is shown in the dealer portal; dealers tap "I agree". Each change to the text creates a new version, and dealers are asked to accept again.
- **Consent record:** each dealer's page shows how and when they consented (signed form, verbally, or in the portal) and for which notice version. Staff record signed-form or verbal consent in the dealer form.
- **Copy of a person's data:** the owner taps **Export personal data** on the dealer's page. The file includes the profile, contact log, transactions, orders, approval requests, portal accounts and who opened the profile.
- **Correction:** edit the dealer.
- **Removal:** the owner taps **Remove personal data**. It works for lost prospects with no transactions, and for dealers with no balance and no transactions within the retention period (Store → Privacy, default 10 years). Name, contact details, birthday, address, notes and tags are removed, contact log entries are deleted, and portal accounts are disabled. Financial records stay, without personal details.
- **Access log:** opening a dealer's profile, exporting and removing personal data are recorded in the activity log.

## What the business must do

1. **Publish a privacy notice.** Adapt the starting text in Store → Privacy to your business and get it reviewed.
2. **Collect consent.** For existing dealers, record consent with a signed form or ask them to accept in the portal. The dealer's page shows "Not recorded" until you do.
3. **Name a Data Protection Officer (DPO)** who handles requests and breaches.
4. **Check whether you must register with the NPC.** **Check:** NPC Circular 2022-04 requires registration of data processing systems for organisations with 250 or more employees, those processing sensitive personal information of 1,000 or more people, or whose processing is likely to pose a risk to people's rights. Confirm the current rules at privacy.gov.ph.
5. **Set the retention period** with your accountant (Store → Privacy). **Check:** the period tax and business records must be kept.
6. **Keep backups protected.** Backups contain the same personal data. Store offsite copies encrypted and limit who can open them.

## Data breach response

A breach is any loss of, or unauthorised access to, personal data: a lost phone with the app signed in, a leaked password, a stolen backup, or someone seeing data they shouldn't.

1. **Contain (first hour).**
   - Lost phone: Store → Team accounts → the person → **Sign out everywhere**. The phone deletes its offline copy when it next connects.
   - Leaked password: change it and sign out everywhere; turn on two-step sign-in.
   - Suspected server compromise: take the app offline, keep the server and logs as they are, and restore onto a clean server from a verified backup (README, "Restoring from a backup").
2. **Assess (same day).** Use the activity log (Store → Activity log) to see what was accessed and which dealers are affected. Write down what happened, when it was discovered and what data was involved.
3. **Notify.** **Check:** under NPC Circular 16-03, breaches involving sensitive personal information or information that could enable identity fraud, and that are likely to cause serious harm, must be reported to the NPC and to affected people within 72 hours of discovery. Your DPO decides, with your adviser.
4. **Fix and record.** Fix the cause, keep a record of the breach and the response (the NPC may ask for it), and review whether the same thing could happen again.

| Role | Name | Contact |
|---|---|---|
| Data Protection Officer | | |
| Owner | | |
| Adviser / lawyer | | |
| NPC | National Privacy Commission | privacy.gov.ph |
