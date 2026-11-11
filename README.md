# Forest Portal – Bhadradri Kothagudem

Public Forest & Tourism site + officer Command Control dashboard.
Requires **Node.js 22.5 or newer** (`node -v`) and a **MongoDB Atlas** cluster (or MongoDB connection string).

## Setup & Start
1. Open a terminal in this folder and install dependencies:
   ```sh
   npm install
   ```
2. Configure MongoDB Atlas:
   - Create a cluster in MongoDB Atlas and a database user with read/write permissions.
   - Allow your server IP (or network CIDR) in Atlas **Network Access**.
   - Copy your connection string (`mongodb+srv://...`) and include the database name in the path (for example `...mongodb.net/forest-portal?retryWrites=true&w=majority`). If no database name is included in the URI, `forest-portal` is used by default (or set `MONGODB_DB`).
3. Set `MONGODB_URI` in your environment or in a local `.env` file in the project folder (ignored by `.gitignore`; never commit credentials):
   - Windows PowerShell (current session):
     ```powershell
     $env:MONGODB_URI = "mongodb+srv://<username>:<password>@<cluster-url>/forest-portal?retryWrites=true&w=majority"
     ```
   - Or save in a local `.env` file:
     ```dotenv
     MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-url>/forest-portal?retryWrites=true&w=majority
     ```
   - Linux / macOS:
     ```sh
     export MONGODB_URI="mongodb+srv://<username>:<password>@<cluster-url>/forest-portal?retryWrites=true&w=majority"
     ```
4. Start the server:
   ```sh
   npm start
   ```
   On first run (when no DFO account exists in the `officers` collection), the server creates **DFO001** with a random password and prints it once in the console.
5. Open http://localhost:3000

## Environment Variables
- `MONGODB_URI` (**required**): MongoDB / MongoDB Atlas connection string.
- `MONGODB_DB` (optional): Override the database name (defaults to the database in `MONGODB_URI`, or `forest-portal`).
- `DATA_DIR` / `UPLOADS_DIR` / `SQLITE_PATH` (optional): Paths used only by `npm run migrate` when importing legacy `data/forest.db` and `data/uploads/` files into MongoDB + GridFS.
- `PORT` (optional): HTTP/HTTPS port, defaults to `3000` (Render sets `PORT` automatically).
- `COOKIE_SECURE=1` (recommended behind Render/HTTPS reverse proxies): Marks the session cookie `Secure`.
- `TLS_CERT` / `TLS_KEY` (optional): Enable built-in HTTPS when self-hosting without a proxy.

## Media Storage & MongoDB Atlas Free Tier Limit
- Uploaded complaint photos (up to 15 MB) and videos (up to 60 MB, max 8 files per complaint) are streamed directly into and out of **MongoDB GridFS** (`complaint_media.files` and `complaint_media.chunks` collections) using `MONGODB_URI`.
- Because media is stored inside MongoDB Atlas rather than local disk, uploaded photos and videos **survive Render restarts and redeploys** on ephemeral filesystems.
- **MongoDB Atlas free tier limit:** Atlas M0 free clusters are limited to **512 MB** of total storage (databases, indexes, and GridFS media combined). A few 60 MB videos or many photos will quickly exhaust 512 MB. Keep client-side photo compression active, prefer short compressed videos, or upgrade to a paid Atlas tier (or external object storage) before production rollout.

## Deploying on Render
1. Create a Web Service connected to this repository (Build command: `npm install`, Start command: `npm start`).
2. Set `MONGODB_URI` (without quotes) and `COOKIE_SECURE=1` in Render **Environment** settings (never commit `.env` or credentials).
3. In MongoDB Atlas **Network Access**, allow your Render outbound IP addresses (or `0.0.0.0/0` if Render uses dynamic outbound IPs, paired with a strong database password).

## Migrating Existing SQLite Data & Local Uploads
If upgrading from the earlier SQLite version (`data/forest.db` + `data/uploads/`), run the idempotent migration script after setting `MONGODB_URI`:
```sh
npm run migrate
```
Optionally pass custom paths: `npm run migrate -- path/to/forest.db path/to/uploads`.
- Copies `officers` (keeping existing password hashes), `complaints` (embedding media metadata + `gridfs_id`), `feedback`, and `bookings` into MongoDB idempotently without overwriting existing documents.
- Copies local files from `data/uploads/` into MongoDB GridFS (`complaint_media`), including backfilling `gridfs_id` on previously migrated complaints if needed.
- Does **not** delete or modify `data/forest.db` or `data/uploads/`.

## Updating an existing copy
Copy these over your old folder:
`server.js`, `db.js`, `package.json`, `public/` (all files incl. `sw.js`), `scripts/`, then run `npm install`.

## Flow
- Public site (`/`) → **Command Control Room** → Officer ID + password → `/forest-dashboard.html`.
- Dashboard buttons: **Complaint Officer**, **Feedback inbox**, **Bookings**, **Officers** (DFO only), CSV export, Log out.

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
Command line alternative (with `MONGODB_URI` set): `npm run create-officer -- FRO101 "K. Lakshmi" FRO "StrongPass123"`.
Role **DFO** = admin. Give every other officer a role such as FRO/FSO/FBO.

## IMPORTANT: HTTPS for phones
Phones only allow GPS, the camera-to-web flow and offline mode on **HTTPS** pages (or `localhost`).
`http://192.168.x.x:3000` will NOT give GPS. Options: deploy behind an HTTPS host/proxy, or run with your own certificate:
`TLS_CERT=cert.pem TLS_KEY=key.pem COOKIE_SECURE=1 npm start`.
Open the dashboard once with signal (while logged in) so the phone saves it for offline use.

## Files
- `server.js` API + server · `db.js` MongoDB + GridFS database layer · `scripts/create-officer.js` CLI officer tool · `scripts/migrate-sqlite-to-mongo.js` SQLite/uploads-to-MongoDB + GridFS migration script
- `public/index.html` public site · `public/forest-dashboard.html` officer app · `public/sw.js` offline page cache
- `data/forest.db` & `data/uploads/` legacy local files (kept intact during migration; not modified or used once running on MongoDB + GridFS).
