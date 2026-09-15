const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

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
  sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);

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
app.use(express.static(__dirname));
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));
function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: "Admin login required." });
  next();
}

app.get("/api/products", (_, res) => {
  const rows = db.prepare("SELECT id, filename, original_name, created_at FROM products ORDER BY id DESC").all();
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

app.post("/api/upload", requireAdmin, upload.array("photos", 100), (req, res) => {
  const added = [];
  const duplicates = [];

  for (const file of req.files || []) {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex");
    const existing = db.prepare("SELECT id FROM products WHERE sha256 = ?").get(hash);
    if (existing) {
      duplicates.push(file.originalname);
      fs.unlinkSync(file.path);
      continue;
    }
    db.prepare(
      "INSERT INTO products (filename, original_name, sha256) VALUES (?, ?, ?)"
    ).run(file.filename, file.originalname, hash);
    added.push(file.originalname);
  }
  res.json({ added, duplicates });
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
