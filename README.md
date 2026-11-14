RMS v3 — Public Code Edition Summary
RMS v3 Public Code Edition is a local demonstration copy of the latest private RMS v3 system. It includes the actual React frontend and PHP backend, not just a static showcase.
Main features and setup
- Frontend: React
- Backend: PHP
- Database: MySQL/MariaDB using rms_public_demo
- Local login:
  - Email: admin@gmail.com
  - Password: admin123
- Requirements: XAMPP, Node 22, PHP 8.2+, and Composer.
- Local URL: http://localhost:3001
What's included and excluded
- Includes the actual application screens and API endpoints.
- Database contains table structures but no student or school records.
- Only one administrator account and basic role/status values are seeded.
- CAPTCHA and outbound email are disabled.
- Forgot Password cannot send OTPs.
- No production credentials, private records, backups, logs, or private Git history are included.
Important security reminders
- Use this edition for local demonstration only.
- Never connect it to the private production database.
- Do not deploy the public demo credentials.
- Never publish .env.local, vendor, node_modules, build output, or backend storage.
- Publish only the public project folder in a new GitHub repository.
In short: RMS v3 Public Code Edition is a clean, empty version of the real application intended for local testing, demonstration, and public source-code sharing—not production use.
