# Recall Watch – food recall tracker for anyone who cooks for others

**Safer food for the people you feed.** Recall Watch is a free phone app (Android and
iPhone) for anyone who cooks for other people: families, potlucks, food pantries,
daycares, camps, shelters, and community meals. It keeps track of the food you buy,
checks it against FDA and USDA recalls for the state and stores you choose, and
notifies your phone when something matches. It shows which meals used a recalled item
and drafts a message you can send to the people who ate it.

The idea started in a church soup kitchen, where volunteers wanted a simple way to
know if anything they'd served had been recalled.

Privacy: the app never stores anyone's contact information. Records stay on your phone
and are deleted automatically after 60 days (adjustable). The item list used for phone
alerts is stored as an encrypted GitHub secret, so it is not visible in this public
repository and is not copied by forks.

## What's here
- `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/` – the phone app
- `lib/match.js` – recall matching rules (shared by the app and the daily check)
- `scripts/check-recalls.mjs` + `.github/workflows/check-recalls.yml` – daily recall check
- `data/recalls.json` – latest recalls (updated automatically)
- `vendor/sealbox.js` – encrypts the item list before it is sent to GitHub (tweetnacl + blakejs)
- `SETUP-check-recalls.yml` – spare copy of the workflow file, in case the hidden
  `.github` folder doesn't upload (see the setup guide)

## Setup (short version)
1. Upload these files to a new **public** GitHub repository named `recall-watch`.
2. Settings › Pages › Deploy from branch › `main` / root.
3. Settings › Actions › General › Workflow permissions › Read and write.
4. Install the free **ntfy** app, subscribe to a hard-to-guess topic, and save the same
   name as the repository secret `NTFY_TOPIC`.
5. Actions › Check food recalls › Run workflow. (GitHub wakes it hourly; it checks as
   often as chosen in the app's Settings.)
6. Open `https://YOUR-USERNAME.github.io/recall-watch/` on your phone and add it to the home screen.
   Choose your state, stores, check frequency and auto-delete period.
7. In the app: More › Phone alerts setup › paste a fine-grained GitHub key
   (this repository only; Secrets: read and write; Actions: read and write).

## Data sources
openFDA food enforcement reports, FDA recall announcements (RSS), USDA FSIS Recall API,
Open Food Facts (product names from barcodes). Barcode scanning uses html5-qrcode
(Apache 2.0); receipt reading uses Tesseract.js, loaded on first use.

This is a helper, not a guarantee. Always confirm details on the official recall notice.
