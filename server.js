const express = require("express");
const session = require("express-session");
const multer = require("multer");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { createWorker } = require("tesseract.js");
const sharp = require("sharp");
const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeMe123!";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "pharma-images";

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 100 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif|jpg)$/i.test(file.mimetype);
    cb(ok ? null : new Error("Only image files are allowed."), ok);
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" }
}));

// The project files are in the repository root.
app.use(express.static(__dirname));
app.get("/admin.html", (req, res) => {
  res.sendFile(__dirname + "/admin.html");
});

function requireSupabase(res) {
  if (!supabase) {
    res.status(503).json({
      error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render."
    });
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: "Admin login required." });
  next();
}

function publicUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(SUPABASE_BUCKET)}/${path
    .split("/").map(encodeURIComponent).join("/")}`;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function makeSearchText(row) {
  return cleanText([
    row.product_name,
    row.content,
    row.ocr_text,
    row.filename,
    row.original_name
  ].filter(Boolean).join(" "));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("eng").catch(err => {
      ocrWorkerPromise = null;
      throw err;
    });
  }
  return ocrWorkerPromise;
}

async function runOcr(buffer) {
  const worker = await getOcrWorker();
  const result = await worker.recognize(buffer);
  return cleanText(result?.data?.text || "");
}

async function ensureBucket() {
  if (!supabase) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  const exists = (buckets || []).some(b => b.name === SUPABASE_BUCKET);
  if (!exists) {
    const { error: createError } = await supabase.storage.createBucket(
      SUPABASE_BUCKET,
      { public: true, fileSizeLimit: "15MB", allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] }
    );
    if (createError && !/already exists/i.test(createError.message || "")) throw createError;
  }
}

async function getProducts(q = "") {
  if (!supabase) return null;
  let query = supabase.from("products")
    .select("id,filename,original_name,product_name,content,ocr_text,search_text,sha256,storage_path,created_at")
    .order("created_at", { ascending: false });

  if (q) {
  query = query.or(
    `product_name.ilike.%${q}%,content.ilike.%${q}%,ocr_text.ilike.%${q}%,original_name.ilike.%${q}%,filename.ilike.%${q}%`
  );
}

  const { data, error } = await query;
  if (error) throw error;

  const rows = data || [];

return await Promise.all(rows.map(async p => {
  const { data: signed } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(p.storage_path, 3600);

  return {
    ...p,
    url: signed?.signedUrl || ''
  };
}));
}

app.get("/api/me", (req, res) => res.json({ admin: !!req.session.admin }));

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Invalid username or password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/products", async (req, res) => {
  if (!requireSupabase(res)) return;
  try {
    const rows = await getProducts(cleanText(req.query.q));
    res.json(rows);
  } catch (err) {
    console.error("Products error:", err);
    res.status(500).json({ error: "Catalogue could not be loaded." });
  }
});

app.post("/api/upload", requireAdmin, upload.array("photos", 100), async (req, res) => {
  if (!requireSupabase(res)) return;
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No photos selected." });

  const added = [];
  const duplicates = [];
  const results = [];

  for (const file of files) {
    const hash = sha256(file.buffer);

    const { data: existing } = await supabase.from("products")
      .select("id").eq("sha256", hash).maybeSingle();

    if (existing) {
      duplicates.push(file.originalname);
      continue;
    }

    let ocrText = "";
    try {
      ocrText = await runOcr(file.buffer);
    } catch (err) {
      console.error("OCR error:", err);
    }

    const safeBase = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `medicines/${hash}-${safeBase}`;

    const { error: storageError } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (storageError) {
      if (/already exists/i.test(storageError.message || "")) {
        duplicates.push(file.originalname);
        continue;
      }
      console.error("Storage upload error:", storageError);
      continue;
    }

    const row = {
      filename: safeBase,
      original_name: file.originalname,
      product_name: "",
      content: "",
      ocr_text: ocrText,
      search_text: makeSearchText({
        product_name: "",
        content: "",
        ocr_text: ocrText,
        filename: safeBase,
        original_name: file.originalname
      }),
      sha256: hash,
      storage_path: storagePath
    };

    const { data, error: dbError } = await supabase.from("products")
      .insert(row).select("id,filename,original_name,product_name,content,ocr_text,search_text,sha256,storage_path,created_at").single();

    if (dbError) {
      await supabase.storage.from(SUPABASE_BUCKET).remove([storagePath]);
      console.error("Database insert error:", dbError);
      continue;
    }

    added.push(data);
    results.push({ file: file.originalname, detected: ocrText.slice(0, 300) });
  }

  res.json({ added, duplicates, results });
});

app.post("/api/reindex-ocr", requireAdmin, async (req, res) => {
  if (!requireSupabase(res)) return;
  try {
    const { data: products, error } = await supabase.from("products")
      .select("id,filename,original_name,product_name,content,storage_path");

    if (error) throw error;

    let updated = 0;
    for (const p of products || []) {
      const { data: file, error: downloadError } = await supabase.storage
        .from(SUPABASE_BUCKET).download(p.storage_path);
      if (downloadError) {
        console.error("Download error:", downloadError);
        continue;
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      let ocrText = "";
      try { ocrText = await runOcr(buffer); } catch (err) { console.error("OCR error:", err); }

      const patch = {
        ocr_text: ocrText,
        search_text: makeSearchText({
          product_name: p.product_name,
          content: p.content,
          ocr_text: ocrText,
          filename: p.filename,
          original_name: p.original_name
        })
      };

      const { error: updateError } = await supabase.from("products").update(patch).eq("id", p.id);
      if (!updateError) updated++;
    }

    res.json({ ok: true, updated });
  } catch (err) {
    console.error("Reindex error:", err);
    res.status(500).json({ error: "OCR re-scan failed." });
  }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
  if (!requireSupabase(res)) return;
  try {
    const id = Number(req.params.id);
    const { data: current, error: readError } = await supabase.from("products")
      .select("id,filename,original_name,ocr_text").eq("id", id).single();
    if (readError) throw readError;

    const product_name = cleanText(req.body?.product_name);
    const content = cleanText(req.body?.content);
    const search_text = makeSearchText({
      product_name, content,
      ocr_text: current.ocr_text,
      filename: current.filename,
      original_name: current.original_name
    });

    const { data, error } = await supabase.from("products")
      .update({ product_name, content, search_text })
      .eq("id", id)
      .select().single();

    if (error) throw error;
    res.json({ ...data, url: publicUrl(data.storage_path) });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ error: "Product update failed." });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  if (!requireSupabase(res)) return;
  try {
    const id = Number(req.params.id);
    const { data: p, error: readError } = await supabase.from("products")
      .select("storage_path").eq("id", id).single();
    if (readError) throw readError;

    const { error: storageError } = await supabase.storage
      .from(SUPABASE_BUCKET).remove([p.storage_path]);
    if (storageError) console.error("Storage delete error:", storageError);

    const { error } = await supabase.from("products").delete().eq("id", id);
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Delete failed." });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Request error:", err);
  res.status(400).json({ error: err.message || "Request failed." });
});

app.listen(PORT, () => {
  console.log(`Shivkamal Pharma running on port ${PORT}`);
  
    
      
      
  
    

});
