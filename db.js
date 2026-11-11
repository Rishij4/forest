"use strict";
// Database layer: one SQLite file at data/forest.db (never inside public/).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "forest.db"));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS officers (
  id INTEGER PRIMARY KEY,
  officer_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Officer',
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  division TEXT NOT NULL,
  details TEXT NOT NULL,
  action_taken TEXT NOT NULL DEFAULT 'Awaiting review',
  officer_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  place TEXT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS complaint_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  file TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  orig_name TEXT,
  client_media_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  service TEXT NOT NULL,
  place TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  adults INTEGER NOT NULL,
  children INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  payment_ref TEXT,
  payment_status TEXT NOT NULL DEFAULT 'Not paid',
  status TEXT NOT NULL DEFAULT 'Pending',
  officer_note TEXT NOT NULL DEFAULT '',
  edit_token TEXT
);
`);

// Upgrade older databases (adds GPS + offline-sync columns).
const have = db.prepare("PRAGMA table_info(complaints)").all().map(c => c.name);
for (const [n, t] of [["lat", "REAL"], ["lng", "REAL"], ["accuracy", "REAL"], ["captured_at", "TEXT"], ["client_id", "TEXT"]])
  if (!have.includes(n)) db.exec(`ALTER TABLE complaints ADD COLUMN ${n} ${t}`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_complaints_client ON complaints(client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_client ON complaint_media(ref, client_media_id) WHERE client_media_id IS NOT NULL;`);

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function addOfficer(officerId, name, role, password) {
  const id = String(officerId).trim().toUpperCase();
  const salt = crypto.randomBytes(16).toString("hex");
  const h = hash(password, salt);
  const exists = db.prepare("SELECT 1 FROM officers WHERE officer_id = ?").get(id);
  if (exists) {
    db.prepare("UPDATE officers SET name = ?, role = ?, pw_salt = ?, pw_hash = ? WHERE officer_id = ?")
      .run(name, role, salt, h, id);
    return "updated";
  }
  db.prepare("INSERT INTO officers (officer_id, name, role, pw_salt, pw_hash) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, role, salt, h);
  return "created";
}

function checkLogin(officerId, password) {
  const row = db.prepare("SELECT * FROM officers WHERE officer_id = ?")
    .get(String(officerId).trim().toUpperCase());
  // Always do the hash work so timing does not reveal whether the ID exists.
  const salt = row ? row.pw_salt : "0".repeat(32);
  const given = Buffer.from(hash(String(password), salt), "hex");
  const stored = Buffer.from(row ? row.pw_hash : "0".repeat(128), "hex");
  const ok = crypto.timingSafeEqual(given, stored) && !!row;
  return ok ? row : null;
}

function setPassword(officerId, password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return db.prepare("UPDATE officers SET pw_salt = ?, pw_hash = ? WHERE officer_id = ?")
    .run(salt, hash(password, salt), String(officerId).trim().toUpperCase()).changes > 0;
}

module.exports = { db, addOfficer, checkLogin, setPassword, DATA_DIR, UPLOAD_DIR };
