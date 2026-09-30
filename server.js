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
const SESSION_SECRET =
  process.env.SESSION_SECRET || "change-this-session-secret";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_BUCKET =
  process.env.SUPABASE_BUCKET || "pharma-images";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false
          }
        }
      )
    : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 100
  },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif|jpg)$/i.test(
      file.mimetype
    );

    cb(
      ok ? null : new Error("Only image files are allowed."),
      ok
    );
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.set("trust proxy", 1);

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    }
  })
);

app.use(express.static(__dirname));

app.get("/admin.html", (req, res) => {
  res.sendFile(__dirname + "/admin.html");
});

function requireSupabase(res) {
  if (!supabase) {
    res.status(503).json({
      error:
        "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render."
    });

    return false;
  }

  return true;
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res
      .status(401)
      .json({ error: "Admin login required." });
  }

  next();
}

function publicUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(
    SUPABASE_BUCKET
  )}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearch(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/gi, "");
}

function makeSearchText(row) {
  return cleanText(
    [
      row.product_name,
      row.content,
      row.ocr_text,
      row.filename,
      row.original_name
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function sha256(buffer) {
  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");
}

/* =========================
   OCR
========================= */

let ocrWorkerPromise = null;

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("eng").catch((err) => {
      ocrWorkerPromise = null;
      throw err;
    });
  }

  return ocrWorkerPromise;
}

async function prepareImage(buffer, mode) {
  let image = sharp(buffer)
    .rotate()
    .resize({
      width: 3000,
      withoutEnlargement: false
    })
    .grayscale();

  if (mode === "normal") {
    image = image
      .normalize()
      .sharpen();
  }

  if (mode === "threshold") {
    image = image
      .normalize()
      .threshold(150);
  }

  if (mode === "high") {
    image = image
      .normalize()
      .sharpen({
        sigma: 2
      });
  }

  return image.png().toBuffer();
}

async function runOcr(buffer) {
  const worker = await getOcrWorker();

  const images = [];

  try {
    images.push(
      await prepareImage(buffer, "normal")
    );
  } catch (err) {
    console.error("OCR normal image error:", err);
  }

  try {
    images.push(
      await prepareImage(buffer, "threshold")
    );
  } catch (err) {
    console.error("OCR threshold image error:", err);
  }

  try {
    images.push(
      await prepareImage(buffer, "high")
    );
  } catch (err) {
    console.error("OCR high image error:", err);
  }

  const texts = [];

  for (const image of images) {
    for (const psm of ["6", "11", "12"]) {
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: psm,
          preserve_interword_spaces: "1"
        });

        const result = await worker.recognize(image);

        const text = cleanText(
          result?.data?.text || ""
        );

        if (text) {
          texts.push(text);
        }
      } catch (err) {
        console.error(
          `OCR error PSM ${psm}:`,
          err
        );
      }
    }
  }

  const unique = [
    ...new Set(
      texts
        .map(cleanText)
        .filter(Boolean)
    )
  ];

  return cleanText(unique.join(" "));
}

/* =========================
   SUPABASE
========================= */

async function ensureBucket() {
  if (!supabase) return;

  const {
    data: buckets,
    error
  } = await supabase.storage.listBuckets();

  if (error) throw error;

  const exists = (buckets || []).some(
    (b) => b.name === SUPABASE_BUCKET
  );

  if (!exists) {
    const {
      error: createError
    } = await supabase.storage.createBucket(
      SUPABASE_BUCKET,
      {
        public: true,
        fileSizeLimit: "15MB",
        allowedMimeTypes: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif"
        ]
      }
    );

    if (
      createError &&
      !/already exists/i.test(
        createError.message || ""
      )
    ) {
      throw createError;
    }
  }
}

/* =========================
   PRODUCTS
========================= */

async function getProducts(q = "") {
  if (!supabase) return null;

  const {
    data,
    error
  } = await supabase
    .from("products")
    .select(
      "id,filename,original_name,product_name,content,ocr_text,search_text,sha256,storage_path,created_at"
    )
    .order("created_at", {
      ascending: false
    });

  if (error) throw error;

  const rows = data || [];

  if (!rows.length) return [];

  const paths = rows
    .map((p) => p.storage_path)
    .filter(Boolean);

  let signed = [];

  try {
    const result =
      await supabase.storage
        .from(SUPABASE_BUCKET)
        .createSignedUrls(
          paths,
          3600
        );

    if (result.error) {
      throw result.error;
    }

    signed = result.data || [];
  } catch (err) {
    console.error(
      "Signed URLs error:",
      err
    );
  }

  const urlMap = new Map(
    signed.map((x) => [
      x.path,
      x.signedUrl
    ])
  );

  return rows.map((p) => ({
    ...p,
    url:
      urlMap.get(p.storage_path) ||
      ""
  }));
}

/* =========================
   LOGIN
========================= */

app.get("/api/me", (req, res) => {
  res.json({
    admin: !!req.session.admin
  });
});

app.post("/api/login", (req, res) => {
  const {
    username,
    password
  } = req.body || {};

  if (
    username === ADMIN_USER &&
    password === ADMIN_PASSWORD
  ) {
    req.session.admin = true;

    return res.json({
      ok: true
    });
  }

  res.status(401).json({
    error:
      "Invalid username or password."
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() =>
    res.json({
      ok: true
    })
  );
});

/* =========================
   PRODUCTS API
========================= */

app.get(
  "/api/products",
  async (req, res) => {
    if (!requireSupabase(res)) return;

    try {
      const rows =
        await getProducts();

      const q = normalizeSearch(
        req.query.q
      );

      if (!q) {
        return res.json(rows);
      }

      const filtered =
        rows.filter((x) => {
          const text =
            normalizeSearch(
              [
                x.product_name,
                x.content,
                x.ocr_text,
                x.original_name,
                x.filename,
                x.search_text
              ]
                .filter(Boolean)
                .join(" ")
            );

          return text.includes(q);
        });

      res.json(filtered);
    } catch (err) {
      console.error(
        "Products error:",
        err
      );

      res.status(500).json({
        error:
          "Catalogue could not be loaded."
      });
    }
  }
);

/* =========================
   UPLOAD
========================= */

app.post(
  "/api/upload",
  requireAdmin,
  upload.array("photos", 100),
  async (req, res) => {
    if (!requireSupabase(res)) return;

    const files = req.files || [];

    if (!files.length) {
      return res.status(400).json({
        error:
          "No photos selected."
      });
    }

    const added = [];
    const duplicates = [];

    for (const file of files) {
      try {
        const hash =
          sha256(file.buffer);

        const {
          data: existing
        } = await supabase
          .from("products")
          .select("id")
          .eq("sha256", hash)
          .maybeSingle();

        if (existing) {
          duplicates.push(
            file.originalname
          );
          continue;
        }

        const safeBase =
          file.originalname.replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );

        const storagePath =
          `medicines/${hash}-${safeBase}`;

        const {
          error: storageError
        } = await supabase.storage
          .from(SUPABASE_BUCKET)
          .upload(
            storagePath,
            file.buffer,
            {
              contentType:
                file.mimetype,
              upsert: false
            }
          );

        if (storageError) {
          if (
            /already exists/i.test(
              storageError.message || ""
            )
          ) {
            duplicates.push(
              file.originalname
            );
            continue;
          }

          console.error(
            "Storage upload error:",
            storageError
          );

          continue;
        }

        const row = {
          filename: safeBase,
          original_name:
            file.originalname,
          product_name: "",
          content: "",
          ocr_text: "",
          search_text: safeBase,
          sha256: hash,
          storage_path:
            storagePath
        };

        const {
          data,
          error: dbError
        } = await supabase
          .from("products")
          .insert(row)
          .select()
          .single();

        if (dbError) {
          await supabase.storage
            .from(SUPABASE_BUCKET)
            .remove([
              storagePath
            ]);

          console.error(
            "Database insert error:",
            dbError
          );

          continue;
        }

        added.push(data);
      } catch (err) {
        console.error(
          "Upload error:",
          err
        );
      }
    }

    res.json({
      added,
      duplicates,
      results: [],
      message:
        `${added.length} photos uploaded successfully. OCR background मध्ये चालू आहे.`
    });

    /* =========================
       BACKGROUND OCR
    ========================= */

    setImmediate(async () => {
      for (const p of added) {
        try {
          const {
            data: file,
            error:
              downloadError
          } = await supabase.storage
            .from(SUPABASE_BUCKET)
            .download(
              p.storage_path
            );

          if (downloadError) {
            console.error(
              "OCR download error:",
              downloadError
            );
            continue;
          }

          const buffer =
            Buffer.from(
              await file.arrayBuffer()
            );

          let ocrText = "";

          try {
            ocrText =
              await runOcr(buffer);
          } catch (ocrError) {
            console.error(
              `OCR error for ${p.original_name}:`,
              ocrError
            );
          }

          const search_text =
            makeSearchText({
              product_name:
                p.product_name,
              content:
                p.content,
              ocr_text:
                ocrText,
              filename:
                p.filename,
              original_name:
                p.original_name
            });

          const {
            error: updateError
          } = await supabase
            .from("products")
            .update({
              ocr_text:
                ocrText,
              search_text:
                search_text
            })
            .eq(
              "id",
              p.id
            );

          if (updateError) {
            console.error(
              "OCR database update error:",
              updateError
            );
          } else {
            console.log(
              `OCR completed: ${p.original_name}`
            );
          }
        } catch (err) {
          console.error(
            `Background OCR failed for ${p.original_name}:`,
            err
          );
        }
      }

      console.log(
        `Background OCR finished for ${added.length} photos.`
      );
    });
  }
);

/* =========================
   OCR RE-SCAN
========================= */

app.post(
  "/api/reindex-ocr",
  requireAdmin,
  async (req, res) => {
    if (!requireSupabase(res))
      return;

    try {
      const {
        data: products,
        error
      } = await supabase
        .from("products")
        .select(
          "id,filename,original_name,product_name,content,storage_path"
        );

      if (error) throw error;

      let updated = 0;

      for (const p of products || []) {
        try {
          const {
            data: file,
            error:
              downloadError
          } =
            await supabase.storage
              .from(
                SUPABASE_BUCKET
              )
              .download(
                p.storage_path
              );

          if (downloadError) {
            console.error(
              "Download error:",
              downloadError
            );
            continue;
          }

          const buffer =
            Buffer.from(
              await file.arrayBuffer()
            );

          let ocrText = "";

          try {
            ocrText =
              await runOcr(buffer);
          } catch (err) {
            console.error(
              "OCR error:",
              err
            );
          }

          const search_text =
            makeSearchText({
              product_name:
                p.product_name,
              content:
                p.content,
              ocr_text:
                ocrText,
              filename:
                p.filename,
              original_name:
                p.original_name
            });

          const {
            error: updateError
          } =
            await supabase
              .from("products")
              .update({
                ocr_text:
                  ocrText,
                search_text:
                  search_text
              })
              .eq(
                "id",
                p.id
              );

          if (!updateError) {
            updated++;
          }
        } catch (err) {
          console.error(
            `Re-scan failed for ${p.original_name}:`,
            err
          );
        }
      }

      res.json({
        ok: true,
        updated
      });
    } catch (err) {
      console.error(
        "Reindex error:",
        err
      );

      res.status(500).json({
        error:
          "OCR re-scan failed."
      });
    }
  }
);

/* =========================
   EDIT PRODUCT
========================= */

app.put(
  "/api/products/:id",
  requireAdmin,
  async (req, res) => {
    if (!requireSupabase(res))
      return;

    try {
      const id =
        Number(req.params.id);

      const {
        data: current,
        error: readError
      } = await supabase
        .from("products")
        .select(
          "id,filename,original_name,ocr_text"
        )
        .eq("id", id)
        .single();

      if (readError)
        throw readError;

      const product_name =
        cleanText(
          req.body?.product_name
        );

      const content =
        cleanText(
          req.body?.content
        );

      const search_text =
        makeSearchText({
          product_name,
          content,
          ocr_text:
            current.ocr_text,
          filename:
            current.filename,
          original_name:
            current.original_name
        });

      const {
        data,
        error
      } = await supabase
        .from("products")
        .update({
          product_name,
          content,
          search_text
        })
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      res.json({
        ...data,
        url: publicUrl(
          data.storage_path
        )
      });
    } catch (err) {
      console.error(
        "Update error:",
        err
      );

      res.status(500).json({
        error:
          "Product update failed."
      });
    }
  }
);

/* =========================
   DELETE PRODUCT
========================= */

app.delete(
  "/api/products/:id",
  requireAdmin,
  async (req, res) => {
    if (!requireSupabase(res))
      return;

    try {
      const id =
        Number(req.params.id);

      const {
        data: p,
        error: readError
      } = await supabase
        .from("products")
        .select("storage_path")
        .eq("id", id)
        .single();

      if (readError)
        throw readError;

      const {
        error: storageError
      } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .remove([
          p.storage_path
        ]);

      if (storageError) {
        console.error(
          "Storage delete error:",
          storageError
        );
      }

      const {
        error
      } = await supabase
        .from("products")
        .delete()
        .eq("id", id);

      if (error) throw error;

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "Delete error:",
        err
      );

      res.status(500).json({
        error:
          "Delete failed."
      });
    }
  }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
  (err, _req, res, _next) => {
    console.error(
      "Request error:",
      err
    );

    res.status(400).json({
      error:
        err.message ||
        "Request failed."
    });
  }
);

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Shivkamal Pharma running on port ${PORT}`
    );
  }
);
