const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { createWorker } = require("tesseract.js");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeMe123!";

const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(path.join(dataDir, "catalogue.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  ocr_text TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
for (const sql of [
  "ALTER TABLE products ADD COLUMN product_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE products ADD COLUMN content TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE products ADD COLUMN ocr_text TEXT NOT NULL DEFAULT ''"
]) {
  try { db.exec(sql); } catch (e) {
    if (!String(e.message).toLowerCase().includes("duplicate column name")) throw e;
  }
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype);
    cb(ok ? null : new Error("Only image files are allowed."), ok);
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "replace-this-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false }
}));
// Files in this project are at repository root (not inside /public).
app.use(express.static(__dirname));
app.use("/uploads", express.static(uploadDir));

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: "Admin login required." });
  next();
}

app.get("/api/products", (_, res) => {
  const rows = db.prepare("SELECT id, filename, original_name, product_name, content, ocr_text, created_at FROM products ORDER BY id DESC").all();
  res.json(rows.map(r => ({ ...r, url: `/uploads/${r.filename}` })));
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Invalid admin credentials." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => res.json({ admin: !!req.session.admin }));

async function ocrImage(filePath) {
  let worker;
  try {
    worker = await createWorker("eng");
    const result = await worker.recognize(filePath);
    return String(result?.data?.text || "").replace(/\s+/g, " ").trim();
  } catch (e) {
    console.error("OCR failed:", e.message);
    return "";
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch (_) {}
    }
  }
}

function guessedProductName(text, fallback) {
  const lines = String(text || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
  const good = lines.find(line => {
    const clean = line.replace(/[^A-Za-z0-9+&() .\/-]/g, " ").trim();
    return clean.length >= 3 && clean.length <= 80 && /[A-Za-z]/.test(clean);
  });
  return good || fallback || "";
}

app.post("/api/upload", requireAdmin, upload.array("photos", 100), async (req, res) => {
  const added = [];
  const duplicates = [];
  const results = [];

  for (const file of req.files || []) {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex");
    const existing = db.prepare("SELECT id FROM products WHERE sha256 = ?").get(hash);
    if (existing) {
      duplicates.push(file.originalname);
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      continue;
    }

    // OCR automatically reads the visible medicine/brand/content text.
    const ocrText = await ocrImage(file.path);
    const guessedName = guessedProductName(ocrText, path.parse(file.originalname).name);

    db.prepare(
      "INSERT INTO products (filename, original_name, product_name, content, ocr_text, sha256) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(file.filename, file.originalname, guessedName, "", ocrText, hash);

    added.push(file.originalname);
    results.push({ file: file.originalname, detected: ocrText || guessedName });
  }

  res.json({ added, duplicates, results });
});

app.put("/api/products/:id", requireAdmin, (req, res) => {
  const productName = String(req.body.product_name || "").trim();
  const content = String(req.body.content || "").trim();
  if (!productName && !content) return res.status(400).json({ error: "Product name किंवा content द्या." });
  const result = db.prepare("UPDATE products SET product_name = ?, content = ? WHERE id = ?").run(productName, content, req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.delete("/api/products/:id", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT filename FROM products WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const full = path.join(uploadDir, row.filename);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || "Upload error" });
  next();
});

app.listen(PORT, () => console.log(`Shivkamal Pharma running on http://localhost:${PORT}`));
