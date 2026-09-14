# Shivkamal Pharma, Latur — Photo Catalogue Website

ही एक deployable Node.js website आहे.

## Features
- Customer catalogue: `/`
- Admin panel: `/admin.html`
- Photo upload/delete फक्त Admin कडे
- Multiple photo upload
- Exact duplicate detection using SHA-256
- Search by uploaded filename
- SQLite database
- Mobile-friendly design
- Shivkamal Pharma logo + दुकानाचा फोटो आधीच जोडलेला आहे

## Run
1. Node.js 18+ install करा.
2. या folder मध्ये terminal उघडा.
3. `npm install`
4. `ADMIN_USER=admin ADMIN_PASSWORD="तुमचा-strong-password" SESSION_SECRET="random-secret" npm start`
5. Browser मध्ये `http://localhost:3000`

Windows PowerShell:
`$env:ADMIN_USER="admin"; $env:ADMIN_PASSWORD="तुमचा-strong-password"; $env:SESSION_SECRET="random-secret"; npm start`

## Important
Production मध्ये default password बदलणे आवश्यक आहे आणि HTTPS वापरा.
Customer ला `/` link द्यायची; `/admin.html` फक्त Admin साठी आहे.

## पुढील upgrade
- Product name वेगळ्या field मध्ये save करणे
- Category / brand / composition
- WhatsApp share button
- Cloud storage (so customers can access photos from anywhere)
- Custom domain such as `catalogue.shivkamalpharma.com`