"use strict";
// Usage: npm run create-officer -- DFO001 "M. Venkat" DFO "StrongPassword123"
// Running it again for an existing ID resets that officer's password.
const { connectDb, closeDb, addOfficer } = require("../db");

async function main() {
  const [id, name, role, password] = process.argv.slice(2);
  if (!id || !name || !role || !password) {
    console.error('Usage: npm run create-officer -- <ID> "<Full name>" <Role> "<Password>"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  await connectDb();
  try {
    const action = await addOfficer(id, name, role, password);
    console.log(`Officer ${id.trim().toUpperCase()} ${action}.`);
  } finally {
    await closeDb();
  }
}

main().catch(err => {
  console.error(err?.message || err);
  process.exit(1);
});
