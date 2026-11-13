# RMS v3 — public code edition

Full React frontend and PHP backend copied from the latest private RMS v3
release, with no production records, database dump, saved permissions, logs,
backups, email credentials, Cloudflare keys or private Git history.

This replaces the earlier small static showcase. It preserves the actual
application screens and endpoints. It is an empty local demonstration edition,
not a historical production release or a production deployment package.

## Only demonstration account

- Email / login identifier: **admin@gmail.com**
- Password: **admin123**

This is a local login label. No Gmail account, mailbox connection or email
delivery is created. The deliberately public password is for local demonstration
only; do not deploy this configuration as a public service.

## What is empty

No students, faculty, coaches, departments, campuses, courses, grades, attendance,
finance, surveys, school years, reports, contact history or retention evaluations
are imported. Normal use creates local audit/session entries. Setup seeds only the Admin role, Active account status and the one
administrator needed to sign in. The database schema contains table definitions,
not private data. Some workflows need reference values before they can be used.

Login CAPTCHA defaults to off **only in this copy**. Outbound email defaults to
off; all provider credentials are blank. Forgot Password cannot deliver OTPs in
this edition. The private system's security and credentials are unchanged.

## Local setup with XAMPP

Use Node 22, PHP 8.2+, Composer and MySQL/MariaDB. Place this directory at
`C:/xampp/htdocs/RMS-v3-public`, and start Apache and MySQL.

1. Install PHP dependencies:

   ```sh
   cd backend
   composer install --no-dev --optimize-autoloader
   cd ..
   ```

2. If MySQL needs credentials, copy `backend/.env.example` to
   `backend/.env.local` and edit DB_USERNAME/DB_PASSWORD. Keep the separate
   database name `rms_public_demo`; never point this copy at the private database.

3. From this project's root, initialize the empty demo:

   ```sh
   php tools/setup-demo.php
   ```

   This refuses any nonempty database and cannot reset an existing installation.
   It creates the demo account and generates a fresh local JWT signing key into
   the ignored `backend/.env.local` file. The working authentication code needs
   that local key; no key is shipped in the public source or archive.

4. Start the real frontend:

   ```sh
   cd frontend
   npm ci
   npm start
   ```

5. Open **http://localhost:3001** and use the demo account above. Port 3001 keeps
   this separate from the private development server on port 3000. The proxy
   forwards this demo's API and images to Apache on port 80.

Keep the directory name RMS-v3-public so the configured local paths resolve.
The full PHP application needs a backend/database and cannot run on GitHub Pages.
GitHub can display this repository's source without hosting a running demo.

## Publish this code copy

Create a new empty GitHub repository and upload **only this folder's public
files**. Do not upload the private project/release or its history. Generated
`.env.local`, vendor, node_modules, build output and backend/storage are excluded
by .gitignore; never force-add them. No real keys or personal records should be
added to this edition. Backend mail implementations remain as source code, with
no active provider settings. Historic SQL, test fixtures, operational exports
and private deployment documentation have been omitted.
