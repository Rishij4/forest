"use strict";
// Zero-dependency server: Node 22.5+ (built-in http, sqlite, crypto). Run: npm start
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db, addOfficer, checkLogin, setPassword, UPLOAD_DIR } = require("./db");

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
if (!db.prepare("SELECT 1 FROM officers WHERE role = ? LIMIT 1").get(ADMIN_ROLE)) {
  const pw = crypto.randomBytes(9).toString("base64url");
  let id = "DFO001";
  for (let n = 2; db.prepare("SELECT 1 FROM officers WHERE officer_id = ?").get(id); n++) {
    id = `DFO${String(n).padStart(3, "0")}`;
  }
  addOfficer(id, "District Forest Officer", ADMIN_ROLE, pw);
  console.log(`\n  No DFO account found: created officer  ID: ${id}   Password: ${pw}`);
  console.log("  Save it now (shown once). Add more officers from the dashboard (Officers button).\n");
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
function newRef(prefix, table) {
  const d = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  for (let i = 0; i < 10; i++) {
    const ref = `${prefix}-${d}-${crypto.randomInt(1000, 10000)}`;
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE ref = ?`).get(ref)) return ref;
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
function mediaByRef() {
  const map = new Map();
  for (const m of db.prepare("SELECT ref, file, kind FROM complaint_media ORDER BY id").all()) {
    if (!map.has(m.ref)) map.set(m.ref, []);
    map.get(m.ref).push({ url: "/media/" + m.file, kind: m.kind });
  }
  return map;
}
const toRecord = (r, media) => {
  const hasGps = r.lat != null && r.lng != null;
  const c = DIVISIONS[r.division];
  const list = media.get(r.ref) || [];
  return {
    id: r.ref, timestamp: r.created_at, source: "Complaint", category: r.category, severity: r.severity,
    status: r.status, location: r.division, lat: hasGps ? r.lat : (c?.[0] ?? null), lng: hasGps ? r.lng : (c?.[1] ?? null),
    gps: hasGps, accuracy: r.accuracy, officer: r.officer_id, action: r.action_taken, details: r.details,
    complainant: r.name, phone: r.phone, media: list,
    photo: list.find(m => m.kind === "image")?.url || "", video: list.find(m => m.kind === "video")?.url || ""
  };
};

// ---------- media upload / download ----------
function saveMedia(req, res, sess, ref) {
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const spec = MEDIA_TYPES[type];
  if (!spec) { req.resume(); return send(res, 415, { error: "Only JPG, PNG, WebP photos and MP4, WebM, MOV videos are allowed" }); }
  if (!db.prepare("SELECT 1 FROM complaints WHERE ref = ?").get(ref)) { req.resume(); return send(res, 404, { error: "Complaint not found" }); }
  const mid = clean(req.headers["x-media-id"], 60);
  if (mid && db.prepare("SELECT 1 FROM complaint_media WHERE ref = ? AND client_media_id = ?").get(ref, mid)) {
    req.resume(); return send(res, 200, { ok: true, duplicate: true }); // retry of an upload that already succeeded
  }
  if (db.prepare("SELECT COUNT(*) n FROM complaint_media WHERE ref = ?").get(ref).n >= MAX_MEDIA_PER_COMPLAINT) {
    req.resume(); return send(res, 400, { error: "Too many files for this complaint" });
  }
  if ((+req.headers["content-length"] || 0) > spec[2]) { req.resume(); return send(res, 413, { error: `File too large (max ${spec[2] / 1e6} MB)` }); }
  let name = ""; try { name = clean(decodeURIComponent(req.headers["x-filename"] || ""), 120); } catch { }
  const file = crypto.randomBytes(16).toString("hex") + "." + spec[0];
  const full = path.join(UPLOAD_DIR, file);
  return new Promise(resolve => {
    const out = fs.createWriteStream(full);
    let size = 0, dead = false;
    const fail = (code, msg) => {
      if (dead) return; dead = true; out.destroy(); fs.unlink(full, () => { });
      if (!res.headersSent) send(res, code, { error: msg }); resolve();
    };
    req.on("data", c => { size += c.length; if (size > spec[2]) { fail(413, "File too large"); req.destroy(); } });
    req.on("error", () => fail(400, "Upload interrupted"));
    req.on("aborted", () => fail(400, "Upload interrupted"));
    out.on("error", () => fail(500, "Could not save file"));
    out.on("finish", () => {
      if (dead) return;
      db.prepare("INSERT INTO complaint_media (ref, file, kind, orig_name, client_media_id, created_at) VALUES (?,?,?,?,?,?)")
        .run(ref, file, spec[1], name, mid || null, new Date().toISOString());
      send(res, 201, { ok: true, url: "/media/" + file }); resolve();
    });
    req.pipe(out);
  });
}
function serveMedia(req, res, url) {
  if (!getSession(req)) return send(res, 401, { error: "Login required" });
  const file = url.pathname.slice("/media/".length);
  const m = file.match(/^[a-f0-9]{32}\.(jpg|png|webp|mp4|webm|mov)$/);
  if (!m) return send(res, 404, "Not found");
  const full = path.join(UPLOAD_DIR, file);
  fs.stat(full, (err, st) => {
    if (err) return send(res, 404, "Not found");
    const head = { "Content-Type": EXT_MIME[m[1]], "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes" };
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (rg && (rg[1] || rg[2])) {
      let start = rg[1] ? +rg[1] : Math.max(0, st.size - +rg[2]);
      let end = rg[1] && rg[2] ? Math.min(+rg[2], st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, "Content-Length": st.size });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------- API ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname, ip = req.socket.remoteAddress;
  const sess = getSession(req);
  const needOfficer = () => { if (!sess) { send(res, 401, { error: "Login required" }); return false; } return true; };

  if (m === "POST" && p === "/api/login") {
    if (limited("login:" + ip, 10, 15 * 60 * 1000)) return send(res, 429, { error: "Too many attempts. Try again later." });
    const b = await readJson(req);
    const row = checkLogin(clean(b.officerId, 40), String(b.password ?? "").slice(0, 200));
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
    const ref = newRef("BKD", "feedback");
    db.prepare("INSERT INTO feedback (ref, created_at, category, place, name, phone, email, message) VALUES (?,?,?,?,?,?,?,?)")
      .run(ref, new Date().toISOString(), category, clean(b.place, 200), name, clean(b.phone, 20), clean(b.email, 120), message);
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
      const existing = db.prepare("SELECT * FROM bookings WHERE ref = ? AND payment_status = 'Not paid'").get(prevRef);
      if (existing && existing.edit_token && existing.edit_token.length === prevTok.length &&
          crypto.timingSafeEqual(Buffer.from(existing.edit_token), Buffer.from(prevTok))) {
        db.prepare("UPDATE bookings SET service = ?, place = ?, visit_date = ?, adults = ?, children = ?, name = ?, phone = ?, email = ?, total_amount = ? WHERE ref = ?")
          .run(b.service, place, visitDate, adults, children, name, phone, email, totalAmount, prevRef);
        return send(res, 200, { ok: true, ref: prevRef, editToken: prevTok, totalAmount, status: existing.status, paymentStatus: existing.payment_status });
      }
    }
    const ref = newRef("BKG", "bookings");
    const editToken = crypto.randomBytes(16).toString("hex");
    db.prepare("INSERT INTO bookings (ref, created_at, service, place, visit_date, adults, children, name, phone, email, total_amount, edit_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(ref, new Date().toISOString(), b.service, place, visitDate, adults, children, name, phone, email, totalAmount, editToken);
    return send(res, 201, { ok: true, ref, editToken, totalAmount, status: "Pending", paymentStatus: "Not paid" });
  }

  const bp = p.match(/^\/api\/bookings\/([A-Za-z0-9-]+)\/pay$/);
  if (m === "POST" && bp) {
    if (limited("bkpay:" + ip, 20, 10 * 60 * 1000)) return send(res, 429, { error: "Too many requests. Please try later." });
    const b = await readJson(req);
    const ref = bp[1].toUpperCase(), tok = clean(b.editToken, 64);
    const row = db.prepare("SELECT * FROM bookings WHERE ref = ?").get(ref);
    if (!row || !row.edit_token || row.edit_token.length !== tok.length ||
        !crypto.timingSafeEqual(Buffer.from(row.edit_token), Buffer.from(tok)))
      return send(res, 404, { error: "Booking not found" });
    if (row.payment_status === "Paid (demo)")
      return send(res, 200, { ok: true, paymentRef: row.payment_ref, paymentStatus: row.payment_status, totalAmount: row.total_amount });
    const method = PAYMENT_METHODS.includes(b.paymentMethod) ? b.paymentMethod : "UPI";
    const paymentRef = "PAY-" + crypto.randomInt(1000000000, 10000000000);
    db.prepare("UPDATE bookings SET payment_method = ?, payment_ref = ?, payment_status = 'Paid (demo)' WHERE ref = ?")
      .run(method, paymentRef, ref);
    return send(res, 200, { ok: true, paymentRef, paymentStatus: "Paid (demo)", totalAmount: row.total_amount });
  }

  if (m === "GET" && p === "/api/bookings/status") {
    if (limited("bkst:" + ip, 30, 10 * 60 * 1000)) return send(res, 429, { error: "Too many checks. Please try later." });
    const ref = clean(url.searchParams.get("ref"), 30).toUpperCase();
    if (!ref) return send(res, 400, { error: "Enter a booking reference number" });
    const row = db.prepare("SELECT ref, service, place, visit_date, adults, children, total_amount, payment_status, status, officer_note FROM bookings WHERE ref = ?").get(ref);
    return row ? send(res, 200, row) : send(res, 404, { error: "Booking not found" });
  }

  // Officer-only below
  if (p.startsWith("/api/") && !needOfficer()) return;

  if (m === "GET" && p === "/api/feedback")
    return send(res, 200, db.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 1000").all());

  if (m === "GET" && p === "/api/bookings")
    return send(res, 200, db.prepare("SELECT id, ref, created_at, service, place, visit_date, adults, children, name, phone, email, total_amount, payment_method, payment_ref, payment_status, status, officer_note FROM bookings ORDER BY id DESC LIMIT 1000").all());

  const bm = p.match(/^\/api\/bookings\/([A-Za-z0-9-]+)$/);
  if (m === "PATCH" && bm) {
    const b = await readJson(req);
    if (!BOOKING_STATUSES.includes(b.status)) return send(res, 400, { error: "Invalid booking status" });
    const note = clean(b.note, 300);
    const r = b.note !== undefined
      ? db.prepare("UPDATE bookings SET status = ?, officer_note = ? WHERE ref = ?").run(b.status, note, bm[1].toUpperCase())
      : db.prepare("UPDATE bookings SET status = ? WHERE ref = ?").run(b.status, bm[1].toUpperCase());
    return r.changes ? send(res, 200, { ok: true }) : send(res, 404, { error: "Not found" });
  }

  if (m === "GET" && p === "/api/records") {
    const media = mediaByRef();
    return send(res, 200, db.prepare("SELECT * FROM complaints ORDER BY id DESC LIMIT 1000").all().map(r => toRecord(r, media)));
  }

  if (m === "POST" && p === "/api/complaints") {
    const b = await readJson(req);
    const clientId = clean(b.clientId, 60) || null;
    if (clientId) { // retry of something already saved (offline sync) -> do not duplicate
      const dup = db.prepare("SELECT ref FROM complaints WHERE client_id = ?").get(clientId);
      if (dup) return send(res, 200, { ok: true, ref: dup.ref, duplicate: true });
    }
    const name = clean(b.name, 100), details = clean(b.details, 3000);
    if (!name || !details) return send(res, 400, { error: "Complainant name and details are required" });
    if (!DIVISIONS[b.division]) return send(res, 400, { error: "Choose a division" });
    const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180);
    if ((lat == null) !== (lng == null)) return send(res, 400, { error: "Enter both latitude and longitude" });
    const category = COMPLAINT_CATS.includes(b.category) ? b.category : "Other";
    const severity = SEVERITIES.includes(b.severity) ? b.severity : "Medium";
    const ref = newRef("CMP", "complaints");
    const when = b.capturedAt && !isNaN(Date.parse(b.capturedAt)) ? new Date(b.capturedAt).toISOString() : new Date().toISOString();
    db.prepare("INSERT INTO complaints (ref, created_at, name, phone, category, severity, division, details, officer_id, lat, lng, accuracy, captured_at, client_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(ref, new Date().toISOString(), name, clean(b.phone, 20), category, severity, b.division, details, sess.officerId, lat, lng, num(b.accuracy, 0, 100000), when, clientId);
    return send(res, 201, { ok: true, ref });
  }

  const mm = p.match(/^\/api\/complaints\/([A-Za-z0-9-]+)\/media$/);
  if (m === "POST" && mm) return saveMedia(req, res, sess, mm[1]);

  const pm = p.match(/^\/api\/complaints\/([A-Za-z0-9-]+)$/);
  if (m === "PATCH" && pm) {
    const b = await readJson(req);
    if (!STATUSES.includes(b.status)) return send(res, 400, { error: "Invalid status" });
    const note = clean(b.action, 300);
    const r = note
      ? db.prepare("UPDATE complaints SET status = ?, action_taken = ? WHERE ref = ?").run(b.status, note, pm[1])
      : db.prepare("UPDATE complaints SET status = ? WHERE ref = ?").run(b.status, pm[1]);
    return r.changes ? send(res, 200, { ok: true }) : send(res, 404, { error: "Not found" });
  }

  // ----- officer management (DFO / admin only) -----
  if (p === "/api/officers" || p.startsWith("/api/officers/")) {
    if (sess.role !== ADMIN_ROLE) return send(res, 403, { error: "Only the DFO can manage officers" });
    if (m === "GET" && p === "/api/officers")
      return send(res, 200, db.prepare("SELECT officer_id, name, role, created_at FROM officers ORDER BY id").all());
    if (m === "POST" && p === "/api/officers") {
      const b = await readJson(req);
      const id = clean(b.officerId, 20).toUpperCase(), name = clean(b.name, 100), role = ROLES.includes(b.role) ? b.role : "Other";
      const pw = String(b.password ?? "");
      if (!/^[A-Z0-9_-]{3,20}$/.test(id)) return send(res, 400, { error: "Officer ID: 3-20 letters, numbers, - or _" });
      if (!name) return send(res, 400, { error: "Name is required" });
      if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: "Password must be at least 8 characters" });
      if (db.prepare("SELECT 1 FROM officers WHERE officer_id = ?").get(id)) return send(res, 409, { error: "That Officer ID already exists" });
      addOfficer(id, name, role, pw);
      return send(res, 201, { ok: true });
    }
    const om = p.match(/^\/api\/officers\/([A-Za-z0-9_-]+)$/);
    if (om) {
      const id = om[1].toUpperCase();
      const target = db.prepare("SELECT * FROM officers WHERE officer_id = ?").get(id);
      if (!target) return send(res, 404, { error: "Officer not found" });
      const dropSessions = () => { for (const [k, s] of sessions) if (s.officerId === id) sessions.delete(k); };
      if (m === "PATCH") {
        const b = await readJson(req);
        const pw = String(b.password ?? "");
        if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: "Password must be at least 8 characters" });
        setPassword(id, pw); dropSessions();
        return send(res, 200, { ok: true });
      }
      if (m === "DELETE") {
        if (id === sess.officerId) return send(res, 400, { error: "You cannot remove your own account" });
        if (target.role === ADMIN_ROLE && db.prepare("SELECT COUNT(*) n FROM officers WHERE role = ?").get(ADMIN_ROLE).n <= 1)
          return send(res, 400, { error: "Cannot remove the last DFO account" });
        db.prepare("DELETE FROM officers WHERE officer_id = ?").run(id); dropSessions();
        return send(res, 200, { ok: true });
      }
    }
  }

  if (m === "GET" && p === "/api/export/complaints.csv") {
    const rows = db.prepare("SELECT * FROM complaints ORDER BY id DESC").all();
    return send(res, 200, csv(rows, ["ref", "created_at", "name", "phone", "category", "severity", "status", "division", "lat", "lng", "accuracy", "details", "action_taken", "officer_id"]),
      { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="complaints.csv"' });
  }
  if (m === "GET" && p === "/api/export/feedback.csv") {
    const rows = db.prepare("SELECT * FROM feedback ORDER BY id DESC").all();
    return send(res, 200, csv(rows, ["ref", "created_at", "category", "place", "name", "phone", "email", "message"]),
      { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="feedback.csv"' });
  }
  if (m === "GET" && p === "/api/export/bookings.csv") {
    const rows = db.prepare("SELECT * FROM bookings ORDER BY id DESC").all();
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
    else if (url.pathname.startsWith("/media/") && req.method === "GET") serveMedia(req, res, url);
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
server.listen(PORT, () => console.log(`Forest portal running at ${process.env.TLS_CERT ? "https" : "http"}://localhost:${PORT}`));
