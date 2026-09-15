# Shivkamal Pharma – Automatic OCR Search Update

Features:
- Customer medicine photo catalogue
- Admin-only uploads/deletes
- Exact duplicate detection using SHA-256
- Automatic OCR on uploaded medicine photos (English packaging text)
- Search across OCR text, product name, content/salt and filename
- Optional admin edit for Brand/Product Name and Content/Salt
- Flat repository layout: index.html, admin.html and server.js are at project root

## Render
Build command: `npm install`
Start command: `npm start`

The project serves static files from the repository root and serves uploaded images from `/uploads`.
