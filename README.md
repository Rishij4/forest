# Forest Portal – Bhadradri Kothagudem

Public Forest & Tourism site + officer Command Control dashboard.
No npm install needed. Requires **Node.js 22.5 or newer** (`node -v`).

## Start
1. Open a terminal in this folder.
2. `npm start` – first run prints officer ID **DFO001** + a random password (shown once).
3. Open http://localhost:3000

## Updating an existing copy
Copy these over your old folder and KEEP your `data/` folder (your database is upgraded automatically):
`server.js`, `db.js`, `package.json`, `public/` (all files incl. `sw.js`), `scripts/`.

## Flow
- Public site (`/`) → **Command Control Room** → Officer ID + password → `/forest-dashboard.html`.
- Dashboard buttons: **Complaint Officer**, **Feedback inbox**, **Officers** (DFO only), CSV export, Log out.

## Complaint form (field use)
- **Location:** opens and asks the phone for GPS automatically ("Use my current location" to retry). GPS comes from the
  phone's satellite chip, so it works with **no mobile data**. First fix can take 30–90 s; stay in the open. Latitude/longitude
  can also be typed. Accuracy (± metres) is saved.
- **Photos / video:** photos are shrunk on the phone before upload; video max 60 MB. Up to 8 files per complaint.
- **No internet:** the complaint (with photos and GPS) is saved on the phone and uploads by itself when signal returns
  (banner: "N report(s) waiting to upload", button **Sync now**). Do not clear browser data or log out before it uploads.
- Maps need internet to display; the saved coordinates open in Google Maps from the table later ("Open map").

## Officers (DFO account only)
Dashboard → **Officers**: add officer (ID, name, role, password – "Generate password" button), reset password, remove.
Command line alternative: `npm run create-officer -- FRO101 "K. Lakshmi" FRO "StrongPass123"`.
Role **DFO** = admin. Give every other officer a role such as FRO/FSO/FBO.

## IMPORTANT: HTTPS for phones
Phones only allow GPS, the camera-to-web flow and offline mode on **HTTPS** pages (or `localhost`).
`http://192.168.x.x:3000` will NOT give GPS. Options: deploy behind an HTTPS host/proxy, or run with your own certificate:
`TLS_CERT=cert.pem TLS_KEY=key.pem COOKIE_SECURE=1 npm start`.
Open the dashboard once with signal (while logged in) so the phone saves it for offline use.

## Files
- `server.js` API + server · `db.js` SQLite · `public/index.html` public site · `public/forest-dashboard.html` officer app · `public/sw.js` offline page cache
- `data/forest.db` database and `data/uploads/` photos & videos (outside `public/`; back both up daily).
