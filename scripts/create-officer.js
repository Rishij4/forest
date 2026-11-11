"use strict";
// Usage: npm run create-officer -- DFO001 "M. Venkat" DFO "StrongPassword123"
// Running it again for an existing ID resets that officer's password.
const { addOfficer } = require("../db");
const [id, name, role, password] = process.argv.slice(2);
if (!id || !name || !role || !password) {
  console.error('Usage: npm run create-officer -- <ID> "<Full name>" <Role> "<Password>"');
  process.exit(1);
}
if (password.length < 8) { console.error("Password must be at least 8 characters."); process.exit(1); }
console.log(`Officer ${id.toUpperCase()} ${addOfficer(id, name, role, password)}.`);
