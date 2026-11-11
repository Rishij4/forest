
"use strict";

// One-time / idempotent migration from SQLite (data/forest.db)
// and data/uploads/ to MongoDB Atlas + GridFS.
// Leaves the SQLite database and uploaded files completely intact.
// Usage: npm run migrate [-- path/to/forest.db [path/to/uploads]]

const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { DatabaseSync } = require("node:sqlite");

const {
  connectDb,
  closeDb,
  getMediaBucket,
  DATA_DIR,
  UPLOAD_DIR
} = require("../db");

const EXT_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime"
};

function hasTable(sqliteDb, name) {
  return !!sqliteDb
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(name);
}

function guessContentType(item) {
  const ext = path
    .extname(item.file || item.orig_name || "")
    .toLowerCase();

  return EXT_MIME[ext] ||
    (item.kind === "video" ? "video/mp4" : "image/jpeg");
}

// Copy a local media file into MongoDB GridFS.
// Reuse an existing file only when its filename and complaint reference match.
async function copyMediaToGridFs({
  bucket,
  uploadsDir,
  ref,
  item,
  summary
}) {
  const contentType = item.content_type || guessContentType(item);

  const existing = await bucket.find({
    filename: item.file,
    "metadata.ref": ref
  }).next();

  if (existing) {
    summary.media.skipped++;

    return {
      gridfs_id: existing._id,
      content_type: existing.metadata?.contentType || contentType,
      status: "existing"
    };
  }

  const localPath = path.join(
    uploadsDir,
    path.basename(item.file)
  );

  if (!fs.existsSync(localPath)) {
    summary.media.missing++;

    console.warn(
      `Warning: local media file missing for ${ref}: ${localPath}`
    );

    return {
      gridfs_id: item.gridfs_id || null,
      content_type: contentType,
      status: "missing"
    };
  }

  const upload = bucket.openUploadStream(item.file, {
    metadata: {
      ref,
      kind: item.kind,
      orig_name: item.orig_name || "",
      client_media_id: item.client_media_id || null,
      contentType
    }
  });

  const gridfsId = upload.id;

  try {
    await pipeline(
      fs.createReadStream(localPath),
      upload
    );

    summary.media.uploaded++;

    return {
      gridfs_id: gridfsId,
      content_type: contentType,
      status: "uploaded"
    };
  } catch (err) {
    try {
      await upload.abort();
    } catch {}

    await bucket.delete(gridfsId).catch(() => {});

    throw err;
  }
}

async function migrateSqliteToMongo(options = {}) {
  const sqlitePath = path.resolve(
    options.sqlitePath ||
    process.env.SQLITE_PATH ||
    path.join(DATA_DIR, "forest.db")
  );

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(
      `SQLite database not found at: ${sqlitePath}`
    );
  }

  const uploadsDir = path.resolve(
    options.uploadsDir ||
    process.env.UPLOADS_DIR ||
    UPLOAD_DIR
  );

  const sqliteDb = new DatabaseSync(sqlitePath);

  const manageConnection = !options.collections;

  const cols = options.collections ||
    (await connectDb(options.uri, options.dbName));

  const bucket = options.mediaBucket || getMediaBucket();

  const summary = {
    sqlitePath,
    uploadsDir,

    officers: {
      total: 0,
      inserted: 0,
      skipped: 0
    },

    complaints: {
      total: 0,
      inserted: 0,
      skipped: 0
    },

    media: {
      total: 0,
      uploaded: 0,
      skipped: 0,
      missing: 0
    },

    feedback: {
      total: 0,
      inserted: 0,
      skipped: 0
    },

    bookings: {
      total: 0,
      inserted: 0,
      skipped: 0
    }
  };

  try {
    // ------------------------------------------
    // 1. Migrate officers
    // ------------------------------------------

    if (hasTable(sqliteDb, "officers")) {
      const rows = sqliteDb
        .prepare("SELECT * FROM officers ORDER BY id ASC")
        .all();

      summary.officers.total = rows.length;

      for (const r of rows) {
        const res = await cols.officers.updateOne(
          { officer_id: r.officer_id },
          {
            $setOnInsert: {
              officer_id: r.officer_id,
              name: r.name,
              role: r.role || "Officer",
              pw_salt: r.pw_salt,
              pw_hash: r.pw_hash,
              created_at:
                r.created_at || new Date().toISOString()
            }
          },
          { upsert: true }
        );

        if (res.upsertedCount > 0) {
          summary.officers.inserted++;
        } else {
          summary.officers.skipped++;
        }
      }
    }

    // ------------------------------------------
    // 2. Read complaint media from SQLite
    // ------------------------------------------

    const mediaMap = new Map();

    if (hasTable(sqliteDb, "complaint_media")) {
      const mediaRows = sqliteDb
        .prepare("SELECT * FROM complaint_media ORDER BY id ASC")
        .all();

      for (const m of mediaRows) {
        if (!mediaMap.has(m.ref)) {
          mediaMap.set(m.ref, []);
        }

        mediaMap.get(m.ref).push({
          file: m.file,
          kind: m.kind,
          orig_name: m.orig_name || "",
          client_media_id: m.client_media_id || null,
          created_at:
            m.created_at || new Date().toISOString()
        });
      }
    }

    // ------------------------------------------
    // 3. Migrate complaints and their media
    // ------------------------------------------

    if (hasTable(sqliteDb, "complaints")) {
      const rows = sqliteDb
        .prepare("SELECT * FROM complaints ORDER BY id ASC")
        .all();

      summary.complaints.total = rows.length;

      for (const r of rows) {
        const rawMedia = mediaMap.get(r.ref) || [];

        summary.media.total += rawMedia.length;

        const existingComplaint = await cols.complaints.findOne(
          { ref: r.ref },
          {
            projection: {
              _id: 1,
              media: 1
            }
          }
        );

        // New complaint: copy its media and insert the complaint.
        if (!existingComplaint) {
          const preparedMedia = [];

          for (const item of rawMedia) {
            const copied = await copyMediaToGridFs({
              bucket,
              uploadsDir,
              ref: r.ref,
              item,
              summary
            });

            preparedMedia.push({
              ...item,
              gridfs_id: copied.gridfs_id,
              content_type: copied.content_type
            });
          }

          await cols.complaints.insertOne({
            ref: r.ref,
            created_at: r.created_at,
            name: r.name,
            phone: r.phone || "",
            category: r.category,
            severity: r.severity,
            status: r.status || "Open",
            division: r.division,
            details: r.details,
            action_taken:
              r.action_taken || "Awaiting review",
            officer_id: r.officer_id,
            lat: r.lat ?? null,
            lng: r.lng ?? null,
            accuracy: r.accuracy ?? null,
            captured_at: r.captured_at || r.created_at,
            client_id: r.client_id || null,
            media: preparedMedia
          });

          summary.complaints.inserted++;

        } else {
          // Existing complaint: preserve its MongoDB media
          // and add any missing media from SQLite.

          summary.complaints.skipped++;

          const currentMedia = Array.isArray(
            existingComplaint.media
          )
            ? existingComplaint.media
            : [];

          const nextMedia = [...currentMedia];

          for (const item of rawMedia) {
            // Find matching media using client_media_id
            // when available, otherwise use the filename.

            const existingIndex = nextMedia.findIndex(media => {
              if (
                item.client_media_id &&
                media.client_media_id
              ) {
                return (
                  item.client_media_id ===
                  media.client_media_id
                );
              }

              return media.file === item.file;
            });

            // Already attached to this complaint and stored in GridFS.
            if (
              existingIndex !== -1 &&
              nextMedia[existingIndex].gridfs_id
            ) {
              summary.media.skipped++;
              continue;
            }

            // Copy the missing media into GridFS.
            const copied = await copyMediaToGridFs({
              bucket,
              uploadsDir,
              ref: r.ref,
              item,
              summary
            });

            const preparedMedia = {
              ...item,
              gridfs_id: copied.gridfs_id,
              content_type: copied.content_type
            };

            if (existingIndex !== -1) {
              // Update the existing media entry.
              nextMedia[existingIndex] = {
                ...nextMedia[existingIndex],
                ...preparedMedia
              };
            } else {
              // Add a new media entry.
              nextMedia.push(preparedMedia);
            }
          }

          // Update only when the media array has changed.
          if (
            JSON.stringify(currentMedia) !==
            JSON.stringify(nextMedia)
          ) {
            await cols.complaints.updateOne(
              { ref: r.ref },
              {
                $set: {
                  media: nextMedia
                }
              }
            );
          }
        }
      }
    }

    // ------------------------------------------
    // 4. Migrate feedback
    // ------------------------------------------

    if (hasTable(sqliteDb, "feedback")) {
      const rows = sqliteDb
        .prepare("SELECT * FROM feedback ORDER BY id ASC")
        .all();

      summary.feedback.total = rows.length;

      for (const r of rows) {
        const res = await cols.feedback.updateOne(
          { ref: r.ref },
          {
            $setOnInsert: {
              ref: r.ref,
              created_at: r.created_at,
              category: r.category,
              place: r.place || "",
              name: r.name,
              phone: r.phone || "",
              email: r.email || "",
              message: r.message
            }
          },
          { upsert: true }
        );

        if (res.upsertedCount > 0) {
          summary.feedback.inserted++;
        } else {
          summary.feedback.skipped++;
        }
      }
    }

    // ------------------------------------------
    // 5. Migrate bookings
    // ------------------------------------------

    if (hasTable(sqliteDb, "bookings")) {
      const rows = sqliteDb
        .prepare("SELECT * FROM bookings ORDER BY id ASC")
        .all();

      summary.bookings.total = rows.length;

      for (const r of rows) {
        const res = await cols.bookings.updateOne(
          { ref: r.ref },
          {
            $setOnInsert: {
              ref: r.ref,
              created_at: r.created_at,
              service: r.service,
              place: r.place,
              visit_date: r.visit_date,
              adults: Number(r.adults ?? 0),
              children: Number(r.children ?? 0),
              name: r.name,
              phone: r.phone,
              email: r.email || "",
              total_amount: Number(r.total_amount ?? 0),
              payment_method: r.payment_method ?? null,
              payment_ref: r.payment_ref ?? null,
              payment_status:
                r.payment_status || "Not paid",
              status: r.status || "Pending",
              officer_note: r.officer_note || "",
              edit_token: r.edit_token ?? null
            }
          },
          { upsert: true }
        );

        if (res.upsertedCount > 0) {
          summary.bookings.inserted++;
        } else {
          summary.bookings.skipped++;
        }
      }
    }

  } finally {
    sqliteDb.close();

    if (manageConnection) {
      await closeDb();
    }
  }

  return summary;
}

// ------------------------------------------
// Run migration from command line
// ------------------------------------------

if (require.main === module) {
  migrateSqliteToMongo({
    sqlitePath: process.argv[2],
    uploadsDir: process.argv[3]
  })
    .then(summary => {
      console.log(
        `Migration complete from ${summary.sqlitePath}:`
      );

      for (const name of [
        "officers",
        "complaints",
        "feedback",
        "bookings"
      ]) {
        const s = summary[name];

        console.log(
          `  ${name}: ${s.inserted} inserted, ` +
          `${s.skipped} skipped (total ${s.total})`
        );
      }

      const m = summary.media;

      console.log(
        `  media (GridFS): ${m.uploaded} uploaded, ` +
        `${m.skipped} skipped, ` +
        `${m.missing} missing on disk (total ${m.total})`
      );
    })
    .catch(err => {
      console.error(
        "Migration failed:",
        err?.message || err
      );

      process.exit(1);
    });
}

module.exports = {
  migrateSqliteToMongo
};
