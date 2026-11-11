"use strict";
// Server: Node 22.5+ (built-in http/https, crypto + MongoDB Atlas). Run: npm start
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { connectDb, closeDb, getCollections, getMediaBucket, ObjectId, addOfficer, checkLogin, setPassword } = require("./db");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const SECURE_COOKIE = process.env.COOKIE_SECURE === "1"; // set to 1 when served over HTTPS
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours idle (officers work long field days)
const PROTECTED_PAGES = new Set(["/forest-dashboard.html"]);
const ROLES = ["DFO", "FDO", "FRO", "FSO", "FBO", "Other"];
const ADMIN_ROLE = "DFO"; // only this role can add/remove officers

const DIVISIONS = {
  "Kinnerasani Division": [17.70, 80.78], "Manuguru Division": [17.93, 80.76],
  "Yellandu Division": [17.60, 80.33], "Paloncha Division": [17.60, 80.70],
  "Bhadrachalam Division": [17.67, 80.89], "Kothagudem Division": [17.55, 80.62]
};
const SEVERITIES = ["Low", "Medium", "High", "Critical"];
const STATUSES = ["Open", "Under Action", "Resolved"];
const FEEDBACK_CATS = ["Tourism / visitor facilities", "Forest", "Wildlife", "Other"];
const COMPLAINT_CATS = ["Timber smuggling", "Wildlife poaching", "Illegal felling", "Forest fire",
  "Human-wildlife conflict", "Encroachment", "Sand/mineral smuggling", "Snare found", "Other"];
const BOOKING_FEES = { Safari: [300, 150], Trekking: [200, 100], "Nature walk": [100, 50], "Bird watching": [150, 75] };
const BOOKING_STATUSES = ["Pending", "Confirmed", "Cancelled"];
const PAYMENT_METHODS = ["UPI", "Card", "Net banking"];
// mime -> [extension, kind, max bytes]
const MEDIA_TYPES = {
  "image/jpeg": ["jpg", "image", 15e6], "image/png": ["png", "image", 15e6], "image/webp": ["webp", "image", 15e6],
  "video/mp4": ["mp4", "video", 60e6], "video/webm": ["webm", "video", 60e6], "video/quicktime": ["mov", "video", 60e6]
};
const EXT_MIME = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([m, v]) => [v[0], m]));
const MAX_MEDIA_PER_COMPLAINT = 8;

// ---------- first-run / recovery DFO officer ----------
async function ensureInitialDfo() {
  const { officers } = getCollections();
  if (!(await officers.findOne({ role: ADMIN_ROLE }, { projection: { _id: 1 } }))) {
    const pw = crypto.randomBytes(9).toString("base64url");
    let id = "DFO001";
    for (let n = 2; await officers.findOne({ officer_id: id }, { projection: { _id: 1 } }); n++) {
      id = `DFO${String(n).padStart(3, "0")}`;
    }
    await addOfficer(id, "District Forest Officer", ADMIN_ROLE, pw);
    console.log(`\n  No DFO account found: created officer  ID: ${id}   Password: ${pw}`);
    console.log("  Save it now (shown once). Add more officers from the dashboard (Officers button).\n");
  }
}

// ---------- helpers ----------
const sessions = new Map();
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k);
  for (const [k, a] of hits) if (!a.some(t => now - t < 3600000)) hits.delete(k);
}, 600000).unref();

function cookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  const t = cookies(req).sid, s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  s.exp = Date.now() + SESSION_MS;
  return s;
}
function send(res, code, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, {
    "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
    "Cache-Control": "no-store", ...headers
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { reject(Object.assign(new Error("Invalid JSON"), { code: 400 })); } });
    req.on("error", reject);
  });
}
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const num = (v, min, max) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
async function newRef(prefix, col) {
  const d = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  for (let i = 0; i < 10; i++) {
    const ref = `${prefix}-${d}-${crypto.randomInt(1000, 10000)}`;
    if (!(await col.findOne({ ref }, { projection: { _id: 1 } }))) return ref;
  }
  return `${prefix}-${d}-${Date.now()}`;
}
function csv(rows, cols) {
  const cell = v => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return `"${s.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\r\n");
}
const toRecord = r => {
  const hasGps = r.lat != null && r.lng != null;
  const c = DIVISIONS[r.division];
  const list = (Array.isArray(r.media) ? r.media : []).map(m => ({ url: "/media/" + m.file, kind: m.kind }));
  return {
    id: r.ref, timestamp: r.created_at, source: "Complaint", category: r.category, severity: r.severity,
    status: r.status, location: r.division, lat: hasGps ? r.lat : (c?.[0] ?? null), lng: hasGps ? r.lng : (c?.[1] ?? null),
    gps: hasGps, accuracy: r.accuracy, officer: r.officer_id, action: r.action_taken, details: r.details,
    complainant: r.name, phone: r.phone, media: list,
    photo: list.find(m => m.kind === "image")?.url || "", video: list.find(m => m.kind === "video")?.url || ""
  };
};

// ---------- media upload / download (streamed via MongoDB GridFS) ----------
async function saveMedia(req, res, sess, ref) {
  const { complaints } = getCollections();
  const bucket = getMediaBucket();
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const spec = MEDIA_TYPES[type];
  if (!spec) { req.resume(); return send(res, 415, { error: "Only JPG, PNG, WebP photos and MP4, WebM, MOV videos are allowed" }); }
  const complaint = await complaints.findOne({ ref }, { projection: { _id: 1, media: 1 } });
  if (!complaint) { req.resume(); return send(res, 404, { error: "Complaint not found" }); }
  const media = Array.isArray(complaint.media) ? complaint.media : [];
  const mid = clean(req.headers["x-media-id"], 60);
  if (mid && media.some(m => m.client_media_id === mid)) {
    req.resume(); return send(res, 200, { ok: true, duplicate: true }); // retry of an upload that already succeeded
  }
  if (media.length >= MAX_MEDIA_PER_COMPLAINT) {
    req.resume(); return send(res, 400, { error: "Too many files for this complaint" });
  }
  if ((+req.headers["content-length"] || 0) > spec[2]) { req.resume(); return send(res, 413, { error: `File too large (max ${spec[2] / 1e6} MB)` }); }
  if (req.aborted || req.destroyed) return;
  let name = ""; try { name = clean(decodeURIComponent(req.headers["x-filename"] || ""), 120); } catch { }
  const file = crypto.randomBytes(16).toString("hex") + "." + spec[0];
  const upload = bucket.openUploadStream(file, {
    metadata: { ref, kind: spec[1], orig_name: name, client_media_id: mid || null, contentType: type }
  });
  const gridfsId = upload.id;
  return new Promise(resolve => {
    let size = 0, dead = false;
    const cleanup = async () => {
      try { await upload.abort(); } catch { }
      await bucket.delete(gridfsId).catch(() => { });
      if (!upload.destroyed) upload.destroy();
    };
    const fail = async (code, msg) => {
      if (dead) return;
      dead = true;
      req.unpipe(upload);
      req.resume();
      await cleanup();
      if (!res.headersSent) send(res, code, { error: msg });
      resolve();
    };
    req.on("data", c => {
      if (dead) return;
      size += c.length;
      if (size > spec[2]) { fail(413, "File too large"); req.destroy(); }
    });
    req.on("error", () => fail(400, "Upload interrupted"));
    req.on("aborted", () => fail(400, "Upload interrupted"));
    req.on("close", () => { if (!req.complete) fail(400, "Upload interrupted"); });
    upload.on("error", err => { console.error(err); fail(500, "Could not save file"); });
    upload.on("finish", async () => {
      if (dead) { await bucket.delete(gridfsId).catch(() => { }); return; }
      try {
        const entry = {
          gridfs_id: gridfsId,
          file,
          kind: spec[1],
          content_type: type,
          orig_name: name,
          client_media_id: mid || null,
          created_at: new Date().toISOString()
        };
        const filter = { ref, [`media.${MAX_MEDIA_PER_COMPLAINT - 1}`]: { $exists: false } };
        if (mid) filter["media.client_media_id"] = { $ne: mid };
        const upd = await complaints.updateOne(filter, { $push: { media: entry } });
        if (upd.matchedCount === 0) {
          await bucket.delete(gridfsId).catch(() => { });
          const latest = await complaints.findOne({ ref }, { projection: { _id: 1, media: 1 } });
          if (!latest) return fail(404, "Complaint not found");
          if (mid && (latest.media || []).some(m => m.client_media_id === mid)) {
            if (!res.headersSent) send(res, 200, { ok: true, duplicate: true });
            return resolve();
          }
          return fail(400, "Too many files for this complaint");
        }
        send(res, 201, { ok: true, url: "/media/" + file });
        resolve();
      } catch (err) {
        console.error(err);
        await fail(500, "Could not save file");
      }
    });
    req.pipe(upload);
  });
}
async function serveMedia(req, res, url) {
  if (!getSession(req)) return send(res, 401, { error: "Login required" });
  const file = url.pathname.slice("/media/".length);
  const m = file.match(/^[a-f0-9]{32}\.(jpg|png|webp|mp4|webm|mov)$/);
  if (!m) return send(res, 404, "Not found");
  const { complaints } = getCollections();
  const bucket = getMediaBucket();
  const cDoc = await complaints.findOne(
    { "media.file": file },
    { projection: { _id: 0, media: { $elemMatch: { file } } } }
  );
  const entry = cDoc?.media?.[0];
  if (!entry) return send(res, 404, "Not found");
  let fileFilter = { filename: file };
  if (entry.gridfs_id) {
    try { fileFilter = { _id: typeof entry.gridfs_id === "string" ? new ObjectId(entry.gridfs_id) : entry.gridfs_id }; } catch { }
  }
  const fileDoc = await bucket.find(fileFilter, { limit: 1 }).next();
  if (!fileDoc) return send(res, 404, "Not found");
  const size = fileDoc.length;
  const contentType = entry.content_type || fileDoc.metadata?.contentType || EXT_MIME[m[1]];
  const head = {
    "Content-Type": contentType, "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes"
  };
  const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let dl;
  if (rg && (rg[1] || rg[2])) {
    let start = rg[1] ? +rg[1] : Math.max(0, size - +rg[2]);
    let end = rg[1] && rg[2] ? Math.min(+rg[2], size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    dl = bucket.openDownloadStream(fileDoc._id, { start, end: end + 1 });
  } else {
    res.writeHead(200, { ...head, "Content-Length": size });
    if (size === 0) return res.end();
    dl = bucket.openDownloadStream(fileDoc._id);
  }
  res.on("close", () => { if (dl && !dl.destroyed) dl.destroy(); });
  dl.on("error", err => {
    console.error(err);
    if (!res.headersSent) send(res, 500, "Error reading file");
    else if (!res.destroyed) res.destroy();
  });
  dl.pipe(res);
}

// ---------- API ----------
async function api(req, res, url) {
  const { officers, complaints, feedback, bookings } = getCollections();
  const m = req.method, p = url.pathname, ip = req.socket.remoteAddress;
  const sess = getSession(req);
  const needOfficer = () => { if (!sess) { send(res, 401, { error: "Login required" }); return false; } return true; };

  if (m === "POST" && p === "/api/login") {
    if (limited("login:" + ip, 10, 15 * 60 * 1000)) return send(res, 429, { error: "Too many attempts. Try again later." });
    const b = await readJson(req);
    const row = await checkLogin(clean(b.officerId, 40), String(b.password ?? "").slice(0, 200));
    if (!row) return send(res, 401, { error: "Invalid Officer ID or password" });
    const sid = crypto.randomBytes(32).toString("hex");
    sessions.set(sid, { officerId: row.officer_id, name: row.name, role: row.role, exp: Date.now() + SESSION_MS });
    return send(res, 200, { ok: true, name: row.name }, {
      "Set-Cookie": `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${SECURE_COOKIE ? "; Secure" : ""}`
    });
  }
  if (m === "POST" && p === "/api/logout") {
    const t = cookies(req).sid; if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }
  if (m === "GET" && p === "/api/me") {
    return needOfficer() && send(res, 200, { officerId: sess.officerId, name: sess.name, role: sess.role, admin: sess.role === ADMIN_ROLE });
  }

  // Public: submit feedback
  if (m === "POST" && p === "/api/feedback") {
    if (limited("fb:" + ip, 5, 10 * 60 * 1000)) return send(res, 429, { error: "Too many submissions. Please try later." });
    const b = await readJson(req);
    const name = clean(b.name, 100), message = clean(b.message, 2000);
    if (!name || !message) return send(res, 400, { error: "Name and message are required" });
    const category = FEEDBACK_CATS.includes(b.category) ? b.category : "Other";
    const ref = await newRef("BKD", feedback);
    await feedback.insertOne({
      ref,
      created_at: new Date().toISOString(),
      category,
      place: clean(b.place, 200),
      name,
      phone: clean(b.phone, 20),
      email: clean(b.email, 120),
      message
    });
    return send(res, 201, { ok: true, ref });
  }

  // Public: submit & check eco-tourism bookings
  if (m === "POST" && p === "/api/bookings") {
    if (limited("bk:" + ip, 10, 10 * 60 * 1000)) return send(res, 429, { error: "Too many booking requests. Please try later." });
    const b = await readJson(req);
    if (!Object.hasOwn(BOOKING_FEES, b.service)) return send(res, 400, { error: "Choose a valid service" });
    const place = clean(b.place, 120), visitDate = clean(b.visitDate, 20);
    const name = clean(b.name, 100), phone = clean(b.phone, 20), email = clean(b.email, 120);
    const adults = num(b.adults, 1, 50), children = num(b.children ?? 0, 0, 50);
    if (!place || !name || !phone || !/^\d{4}-\d{2}-\d{2}$/.test(visitDate) || isNaN(Date.parse(visitDate)))
      return send(res, 400, { error: "Service, place, visit date, name and phone are required" });
    if (adults == null || !Number.isInteger(adults) || children == null || !Number.isInteger(children))
      return send(res, 400, { error: "Enter valid visitor counts" });
    const fee = BOOKING_FEES[b.service];
    const totalAmount = adults * fee[0] + children * fee[1];
    const prevRef = clean(b.ref, 30).toUpperCase(), prevTok = clean(b.editToken, 64);
    if (prevRef && prevTok) {
      const existing = await bookings.findOne({ ref: prevRef, payment_status: "Not paid" });
      if (existing && existing.edit_token && existing.edit_token.length === prevTok.length &&
          crypto.timingSafeEqual(Buffer.from(existing.edit_token), Buffer.from(prevTok))) {
        await bookings.updateOne(
          { ref: prevRef },
          {
            $set: {
              service: b.service, place, visit_date: visitDate, adults, children,
              name, phone, email, total_amount: totalAmount
            }
          }
        );
        return send(res, 200, { ok: true, ref: prevRef, editToken: prevTok, totalAmount, status: existing.status, paymentStatus: existing.payment_status });
      }
    }
    const ref = await newRef("BKG", bookings);
    const editToken = crypto.randomBytes(16).toString("hex");
    await bookings.insertOne({
      ref,
      created_at: new Date().toISOString(),
      service: b.service,
      place,
      visit_date: visitDate,
      adults,
      children,
      name,
      phone,
      email,
      total_amount: totalAmount,
      payment_method: null,
      payment_ref: null,
      payment_status: "Not paid",
      status: "Pending",
      officer_note: "",
      edit_token: editToken
    });
    return send(res, 201, { ok: true, ref, editToken, totalAmount, status: "Pending", paymentStatus: "Not paid" });
  }

  const bp = p.match(/^\/api\/bookings\/([A-Za-z0-9-]+)\/pay$/);
  if (m === "POST" && bp) {
    if (limited("bkpay:" + ip, 20, 10 * 60 * 1000)) return send(res, 429, { error: "Too many requests. Please try later." });
    const b = await readJson(req);
    const ref = bp[1].toUpperCase(), tok = clean(b.editToken, 64);
    const row = await bookings.findOne({ ref });
    if (!row || !row.edit_token || row.edit_token.length !== tok.length ||
        !crypto.timingSafeEqual(Buffer.from(row.edit_token), Buffer.from(tok)))
      return send(res, 404, { error: "Booking not found" });
    if (row.payment_status === "Paid (demo)")
      return send(res, 200, { ok: true, paymentRef: row.payment_ref, paymentStatus: row.payment_status, totalAmount: row.total_amount });
    const method = PAYMENT_METHODS.includes(b.paymentMethod) ? b.paymentMethod : "UPI";
    const paymentRef = "PAY-" + crypto.randomInt(1000000000, 10000000000);
    await bookings.updateOne(
      { ref },
      { $set: { payment_method: method, payment_ref: paymentRef, payment_status: "Paid (demo)" } }
    );
    return send(res, 200, { ok: true, paymentRef, paymentStatus: "Paid (demo)", totalAmount: row.total_amount });
  }

  if (m === "GET" && p === "/api/bookings/status") {
    if (limited("bkst:" + ip, 30, 10 * 60 * 1000)) return send(res, 429, { error: "Too many checks. Please try later." });
    const ref = clean(url.searchParams.get("ref"), 30).toUpperCase();
    if (!ref) return send(res, 400, { error: "Enter a booking reference number" });
    const row = await bookings.findOne(
      { ref },
      { projection: { _id: 0, ref: 1, service: 1, place: 1, visit_date: 1, adults: 1, children: 1, total_amount: 1, payment_status: 1, status: 1, officer_note: 1 } }
    );
    return row ? send(res, 200, row) : send(res, 404, { error: "Booking not found" });
  }

  // Officer-only below
  if (p.startsWith("/api/") && !needOfficer()) return;

  if (m === "GET" && p === "/api/feedback") {
    const rows = await feedback.find({}, { projection: { _id: 0 } }).sort({ created_at: -1, _id: -1 }).limit(1000).toArray();
    return send(res, 200, rows);
  }

  if (m === "GET" && p === "/api/bookings") {
    const rows = await bookings.find({}, { projection: { _id: 0, edit_token: 0 } }).sort({ created_at: -1, _id: -1 }).limit(1000).toArray();
    return send(res, 200, rows);
  }

  const bm = p.match(/^\/api\/bookings\/([A-Za-z0-9-]+)$/);
  if (m === "PATCH" && bm) {
    const b = await readJson(req);
    if (!BOOKING_STATUSES.includes(b.status)) return send(res, 400, { error: "Invalid booking status" });
    const note = clean(b.note, 300);
    const upd = b.note !== undefined ? { status: b.status, officer_note: note } : { status: b.status };
    const r = await bookings.updateOne({ ref: bm[1].toUpperCase() }, { $set: upd });
    return r.matchedCount ? send(res, 200, { ok: true }) : send(res, 404, { error: "Not found" });
  }

  if (m === "GET" && p === "/api/records") {
    const rows = await complaints.find({}, { projection: { _id: 0 } }).sort({ created_at: -1, _id: -1 }).limit(1000).toArray();
    return send(res, 200, rows.map(toRecord));
  }

  if (m === "POST" && p === "/api/complaints") {
    const b = await readJson(req);
    const clientId = clean(b.clientId, 60) || null;
    if (clientId) { // retry of something already saved (offline sync) -> do not duplicate
      const dup = await complaints.findOne({ client_id: clientId }, { projection: { _id: 0, ref: 1 } });
      if (dup) return send(res, 200, { ok: true, ref: dup.ref, duplicate: true });
    }
    const name = clean(b.name, 100), details = clean(b.details, 3000);
    if (!name || !details) return send(res, 400, { error: "Complainant name and details are required" });
    if (!DIVISIONS[b.division]) return send(res, 400, { error: "Choose a division" });
    const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180);
    if ((lat == null) !== (lng == null)) return send(res, 400, { error: "Enter both latitude and longitude" });
    const category = COMPLAINT_CATS.includes(b.category) ? b.category : "Other";
    const severity = SEVERITIES.includes(b.severity) ? b.severity : "Medium";
    const ref = await newRef("CMP", complaints);
    const when = b.capturedAt && !isNaN(Date.parse(b.capturedAt)) ? new Date(b.capturedAt).toISOString() : new Date().toISOString();
    try {
      await complaints.insertOne({
        ref,
        created_at: new Date().toISOString(),
        name,
        phone: clean(b.phone, 20),
        category,
        severity,
        status: "Open",
        division: b.division,
        details,
        action_taken: "Awaiting review",
        officer_id: sess.officerId,
        lat,
        lng,
        accuracy: num(b.accuracy, 0, 100000),
        captured_at: when,
        client_id: clientId,
        media: []
      });
    } catch (err) {
      if (err?.code === 11000 && clientId) {
        const dup = await complaints.findOne({ client_id: clientId }, { projection: { _id: 0, ref: 1 } });
        if (dup) return send(res, 200, { ok: true, ref: dup.ref, duplicate: true });
      }
      throw err;
    }
    return send(res, 201, { ok: true, ref });
  }

  const mm = p.match(/^\/api\/complaints\/([A-Za-z0-9-]+)\/media$/);
  if (m === "POST" && mm) return await saveMedia(req, res, sess, mm[1]);

  const pm = p.match(/^\/api\/complaints\/([A-Za-z0-9-]+)$/);
  if (m === "PATCH" && pm) {
    const b = await readJson(req);
    if (!STATUSES.includes(b.status)) return send(res, 400, { error: "Invalid status" });
    const note = clean(b.action, 300);
    const upd = note ? { status: b.status, action_taken: note } : { status: b.status };
    const r = await complaints.updateOne({ ref: pm[1] }, { $set: upd });
    return r.matchedCount ? send(res, 200, { ok: true }) : send(res, 404, { error: "Not found" });
  }

  // ----- officer management (DFO / admin only) -----
  if (p === "/api/officers" || p.startsWith("/api/officers/")) {
    if (sess.role !== ADMIN_ROLE) return send(res, 403, { error: "Only the DFO can manage officers" });
    if (m === "GET" && p === "/api/officers") {
      const rows = await officers.find({}, { projection: { _id: 0, officer_id: 1, name: 1, role: 1, created_at: 1 } })
        .sort({ created_at: 1, _id: 1 }).toArray();
      return send(res, 200, rows);
    }
    if (m === "POST" && p === "/api/officers") {
      const b = await readJson(req);
      const id = clean(b.officerId, 20).toUpperCase(), name = clean(b.name, 100), role = ROLES.includes(b.role) ? b.role : "Other";
      const pw = String(b.password ?? "");
      if (!/^[A-Z0-9_-]{3,20}$/.test(id)) return send(res, 400, { error: "Officer ID: 3-20 letters, numbers, - or _" });
      if (!name) return send(res, 400, { error: "Name is required" });
      if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: "Password must be at least 8 characters" });
      if (await officers.findOne({ officer_id: id }, { projection: { _id: 1 } }))
        return send(res, 409, { error: "That Officer ID already exists" });
      await addOfficer(id, name, role, pw);
      return send(res, 201, { ok: true });
    }
    const om = p.match(/^\/api\/officers\/([A-Za-z0-9_-]+)$/);
    if (om) {
      const id = om[1].toUpperCase();
      const target = await officers.findOne({ officer_id: id });
      if (!target) return send(res, 404, { error: "Officer not found" });
      const dropSessions = () => { for (const [k, s] of sessions) if (s.officerId === id) sessions.delete(k); };
      if (m === "PATCH") {
        const b = await readJson(req);
        const pw = String(b.password ?? "");
        if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: "Password must be at least 8 characters" });
        await setPassword(id, pw); dropSessions();
        return send(res, 200, { ok: true });
      }
      if (m === "DELETE") {
        if (id === sess.officerId) return send(res, 400, { error: "You cannot remove your own account" });
        if (target.role === ADMIN_ROLE && (await officers.countDocuments({ role: ADMIN_ROLE })) <= 1)
          return send(res, 400, { error: "Cannot remove the last DFO account" });
        await officers.deleteOne({ officer_id: id }); dropSessions();
        return send(res, 200, { ok: true });
      }
    }
  }

  if (m === "GET" && p === "/api/export/complaints.csv") {
    const rows = await complaints.find({}, { projection: { _id: 0, media: 0 } }).sort({ created_at: -1, _id: -1 }).toArray();
    return send(res, 200, csv(rows, ["ref", "created_at", "name", "phone", "category", "severity", "status", "division", "lat", "lng", "accuracy", "details", "action_taken", "officer_id"]),
      { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="complaints.csv"' });
  }
  if (m === "GET" && p === "/api/export/feedback.csv") {
    const rows = await feedback.find({}, { projection: { _id: 0 } }).sort({ created_at: -1, _id: -1 }).toArray();
    return send(res, 200, csv(rows, ["ref", "created_at", "category", "place", "name", "phone", "email", "message"]),
      { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="feedback.csv"' });
  }
  if (m === "GET" && p === "/api/export/bookings.csv") {
    const rows = await bookings.find({}, { projection: { _id: 0, edit_token: 0 } }).sort({ created_at: -1, _id: -1 }).toArray();
    return send(res, 200, csv(rows, ["ref", "created_at", "service", "place", "visit_date", "adults", "children", "name", "phone", "email", "total_amount", "payment_status", "payment_method", "payment_ref", "status", "officer_note"]),
      { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="bookings.csv"' });
  }
  send(res, 404, { error: "Not found" });
}

// ---------- static files ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp"
};
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, "Bad request"); }
  if (rel === "/") rel = "/index.html";
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden");
  if (PROTECTED_PAGES.has(rel) && !getSession(req)) { res.writeHead(302, { Location: "/#dashboard" }); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    const noCache = PROTECTED_PAGES.has(rel) || rel === "/sw.js";
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Cache-Control": noCache ? "no-store" : "public, max-age=300"
    });
    res.end(buf);
  });
}

const handler = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (url.pathname.startsWith("/media/") && req.method === "GET") await serveMedia(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") serveStatic(req, res, url);
    else send(res, 405, "Method not allowed");
  } catch (e) {
    if (e.code === 413 || e.code === 400) return send(res, e.code, { error: e.message });
    console.error(e); if (!res.headersSent) send(res, 500, { error: "Server error" });
  }
};

// HTTPS is required for GPS and offline mode on phones. Either run behind an HTTPS host/proxy,
// or set TLS_CERT and TLS_KEY to certificate file paths.
const server = process.env.TLS_CERT && process.env.TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
  : http.createServer(handler);
server.requestTimeout = 10 * 60 * 1000; // allow slow video uploads on weak mobile networks

async function start() {
  await connectDb();
  await ensureInitialDfo();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, () => {
      server.removeListener("error", reject);
      console.log(`Forest portal running at ${process.env.TLS_CERT ? "https" : "http"}://localhost:${PORT}`);
      resolve();
    });
  });
}

function shutdown() {
  server.close(async () => {
    await closeDb().catch(() => { });
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

start().catch(async err => {
  console.error("Failed to start server:", err?.message || err);
  await closeDb().catch(() => { });
  process.exit(1);
});
