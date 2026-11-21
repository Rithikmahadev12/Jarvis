// Backend for Ember (coffee shop)
// Serves the site and stores form submissions to disk.
//   npm install
//   npm start        -> http://localhost:3000
"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "submissions.json");

app.use(express.json());
app.use(express.static(__dirname));

function readSubmissions() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}
function saveSubmission(entry) {
  const all = readSubmissions();
  all.push(entry);
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
}

app.post("/api/contact", (req, res) => {
  const { name, email, message } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: "email is required" });
  saveSubmission({ name: name || "", email, message: message || "", receivedAt: new Date().toISOString() });
  res.json({ ok: true });
});

app.get("/api/submissions", (_req, res) => res.json(readSubmissions()));

app.get("/api/health", (_req, res) => res.json({ ok: true, site: "Ember" }));

app.listen(PORT, () => console.log(`Ember backend running at http://localhost:${PORT}`));
