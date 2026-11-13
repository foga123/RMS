# Public code copy verification

- Full React frontend clean dependency installation passed.
- Production build passed with CI lint enforcement.
- PHP syntax checks passed for 133 application/setup files; final changed PHP files were rechecked.
- Admin login with admin@gmail.com / admin123 returned HTTP 200 and a signed access token.
- Students, overview analytics, campuses, departments, courses and users returned HTTP 200 with valid JSON on the empty demo database.
- Database check confirmed one demo administrator and no students, campuses, departments, courses, grades, attendance or finance records.
- Login CAPTCHA is off in this copy and the provider site key is blank.
- Real HTTP proxy tests passed for paths, queries, request bodies, cookies, filter boundaries and JSON 502 failures.
- Local credential file, schema and setup tool returned HTTP 403 when requested through Apache.
- Default database isolation and private-value/Apps Script URL scans passed.

The temporary demo database and generated local credential/key file were removed after testing. No runtime data is distributed. Dependencies, build output and logs were moved out of this source folder. Run the README setup steps to recreate the empty demo locally.

No email, external CAPTCHA or production deployment was tested or enabled in this edition. GitHub Pages cannot execute this PHP backend. The private application was not modified.
