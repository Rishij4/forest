"use strict";
// Database layer: MongoDB Atlas collections (officers, complaints, feedback, bookings)
// and GridFS bucket (complaint_media) for uploaded photos and videos.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient, GridFSBucket, ObjectId } = require("mongodb");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

function loadLocalEnv() {
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) return;
  try {
    const buf = fs.readFileSync(envFile);
    const raw = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
      ? buf.subarray(2).toString("utf16le")
      : buf.toString("utf8").replace(/^\uFEFF/, "");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || m[1] in process.env) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  } catch { }
}
loadLocalEnv();

let client = null;
let database = null;
let cols = null;
let mediaBucket = null;
let connecting = null;

function parseDbName(uri) {
  try {
    const pathname = new URL(uri).pathname.replace(/^\/+/, "");
    return pathname ? decodeURIComponent(pathname.split("/")[0]) : null;
  } catch {
    return null;
  }
}

async function ensureIndexes(c) {
  await Promise.all([
    c.officers.createIndex({ officer_id: 1 }, { unique: true }),
    c.officers.createIndex({ role: 1 }),
    c.complaints.createIndex({ ref: 1 }, { unique: true }),
    c.complaints.createIndex(
      { client_id: 1 },
      { unique: true, partialFilterExpression: { client_id: { $type: "string" } } }
    ),
    c.complaints.createIndex({ "media.file": 1 }),
    c.complaints.createIndex({ created_at: -1, _id: -1 }),
    c.feedback.createIndex({ ref: 1 }, { unique: true }),
    c.feedback.createIndex({ created_at: -1, _id: -1 }),
    c.bookings.createIndex({ ref: 1 }, { unique: true }),
    c.bookings.createIndex({ created_at: -1, _id: -1 })
  ]);
}

async function connectDb(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB) {
  if (cols) return cols;
  if (connecting) return connecting;

  const connStr = String(uri ?? "").trim();
  if (!connStr) {
    throw new Error("Missing MONGODB_URI environment variable. Set MONGODB_URI to your MongoDB Atlas connection string.");
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(connStr)) {
    throw new Error("Invalid MONGODB_URI. Expected a mongodb:// or mongodb+srv:// connection string.");
  }

  connecting = (async () => {
    let nextClient;
    try {
      nextClient = new MongoClient(connStr, {
        serverSelectionTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS) || 10000
      });
    } catch (err) {
      throw new Error(
        `Invalid MONGODB_URI (${err?.message || "Invalid connection string"}). ` +
        "Make sure there are no extra characters/brackets around the URI, and URL-encode special characters in your password (e.g. '@' -> '%40', '#' -> '%23', ':' -> '%3A', '/' -> '%2F', '?' -> '%3F')."
      );
    }
    await nextClient.connect();
    const resolvedDbName = String(dbName ?? "").trim() || parseDbName(connStr) || "forest-portal";
    const nextDb = nextClient.db(resolvedDbName);
    const nextCols = {
      officers: nextDb.collection("officers"),
      complaints: nextDb.collection("complaints"),
      feedback: nextDb.collection("feedback"),
      bookings: nextDb.collection("bookings")
    };
    const nextBucket = new GridFSBucket(nextDb, { bucketName: "complaint_media" });
    await ensureIndexes(nextCols);
    client = nextClient;
    database = nextDb;
    cols = nextCols;
    mediaBucket = nextBucket;
    return cols;
  })();

  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    throw err;
  }
}

async function closeDb() {
  const c = client;
  client = null;
  database = null;
  cols = null;
  mediaBucket = null;
  connecting = null;
  if (c) await c.close();
}

function getCollections() {
  if (!cols) throw new Error("Database not connected. Call connectDb() first.");
  return cols;
}

function getMediaBucket() {
  if (!mediaBucket) throw new Error("Database not connected. Call connectDb() first.");
  return mediaBucket;
}

function getDb() {
  if (!database) throw new Error("Database not connected. Call connectDb() first.");
  return database;
}

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

async function addOfficer(officerId, name, role, password) {
  const { officers } = await connectDb();
  const id = String(officerId).trim().toUpperCase();
  const salt = crypto.randomBytes(16).toString("hex");
  const h = hash(password, salt);
  const res = await officers.updateOne(
    { officer_id: id },
    {
      $set: { name, role, pw_salt: salt, pw_hash: h },
      $setOnInsert: { officer_id: id, created_at: new Date().toISOString() }
    },
    { upsert: true }
  );
  return res.upsertedCount > 0 ? "created" : "updated";
}

async function checkLogin(officerId, password) {
  const { officers } = await connectDb();
  const row = await officers.findOne({ officer_id: String(officerId).trim().toUpperCase() });
  // Always do the hash work so timing does not reveal whether the ID exists.
  const salt = row ? row.pw_salt : "0".repeat(32);
  const given = Buffer.from(hash(String(password), salt), "hex");
  const stored = Buffer.from(row ? row.pw_hash : "0".repeat(128), "hex");
  const ok = crypto.timingSafeEqual(given, stored) && !!row;
  return ok ? row : null;
}

async function setPassword(officerId, password) {
  const { officers } = await connectDb();
  const salt = crypto.randomBytes(16).toString("hex");
  const res = await officers.updateOne(
    { officer_id: String(officerId).trim().toUpperCase() },
    { $set: { pw_salt: salt, pw_hash: hash(password, salt) } }
  );
  return res.matchedCount > 0;
}

module.exports = {
  connectDb,
  closeDb,
  getDb,
  getCollections,
  getMediaBucket,
  ObjectId,
  addOfficer,
  checkLogin,
  setPassword,
  DATA_DIR,
  UPLOAD_DIR
};
