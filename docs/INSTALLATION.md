# First-time installation on Cloudflare

**Last updated:** 2026-09-08

This is the supported manual runbook for a **new, empty installation**. There is no installation wizard or `npm run setup`; `mail:configure` configures mail only. If you already have a deployment, users, resources or private configuration, **stop** and use [deployment and upgrade guidance](USER-MANAGEMENT.md#deployment-and-rollback). Do not overwrite configuration or silently reuse resources with matching names.

## 1. Prepare your account and checkout

You need Git, **Node.js 22.19+**, npm, and a Cloudflare account with permission to manage Workers, D1 and R2. Workers Free is supported; no Workers Paid subscription is required. Enable R2 in the dashboard (Cloudflare may require billing details/a credit card). R2 usage can incur charges, and Workers/D1 Free quotas can interrupt service: Free does not mean unlimited or guaranteed zero cost.

The commands below use a POSIX shell on Linux/macOS; on Windows use WSL. Run them from the repository root unless shown otherwise. Stop on any failed command.

```bash
git clone https://github.com/lperez37/itransfer-cloudflare.git
cd itransfer-cloudflare
node --version
npm ci
npm ci --prefix frontend
```

Create private, gitignored copies **once**. If any destination exists (including a symbolic link), stop and review it; do not replace it. Leave the tracked public templates unchanged.

```bash
test ! -e wrangler.local.jsonc && test ! -L wrangler.local.jsonc && cp wrangler.jsonc wrangler.local.jsonc
test ! -e r2-cors.local.json && test ! -L r2-cors.local.json && cp r2-cors.json r2-cors.local.json
```

Authenticate Wrangler and check that it selects the intended account, not another account you administer:

```bash
npx wrangler login -c wrangler.local.jsonc
npx wrangler whoami -c wrangler.local.jsonc
```

If you have multiple accounts, set the intended `account_id` in **local** configuration. Treat account/resource output as private; do not paste it into public issues.

## 2. Create the database and bucket

This guide keeps database name `itransfer` and bucket name `itransfer-files`. Check the dashboard for existing resources/Worker named `itransfer` first. **A name conflict is a stop condition**, not permission to attach to or replace an existing deployment.

```bash
npx wrangler d1 create itransfer -c wrangler.local.jsonc --update-config=false
```

Copy the newly returned database UUID into the **existing** `d1_databases` entry in `wrangler.local.jsonc`, replacing its all-zero `database_id`. Keep `binding: "DB"` and `database_name: "itransfer"`. Do not append a second binding or modify the public placeholder file.

```bash
npx wrangler r2 bucket create itransfer-files -c wrangler.local.jsonc --update-config=false
```

Keep the R2 binding named **`BUCKET`**. Its `bucket_name` and `vars.R2_BUCKET_NAME` must both equal the newly created bucket name. If you deliberately choose different resource names, update every corresponding command/configuration reference. The npm database scripts contain the literal name `itransfer`; for a renamed database use the equivalent explicit Wrangler migration command with your new name. Never rename the `DB` or `BUCKET` bindings.

**Only after checking the actual database ID and account**, apply all migrations, starting with `0001`, in order:

```bash
npm run db:migrate:remote -- -c wrangler.local.jsonc
npx wrangler d1 migrations list itransfer --remote -c wrangler.local.jsonc
```

The list must report no pending migrations. Do not apply only the user-management migrations or edit applied SQL. An empty new database does not need a pre-existing production backup; future upgrades do.

## 3. Choose the real HTTPS origin and configure R2

Before generating any links, choose **one canonical origin**:

- **Workers hostname:** in the Cloudflare Workers & Pages dashboard, find/configure your account's exact workers.dev subdomain. With Worker name `itransfer`, the origin is `https://itransfer.<your-subdomain>.workers.dev`. Keep `workers_dev: true`. Do not guess the subdomain.
- **Custom hostname:** use a hostname you control in an active Cloudflare DNS zone. In local configuration set `workers_dev: false` and `routes: [{ "pattern": "files.example.com", "custom_domain": true }]`, replacing that example with your real hostname. Cloudflare provisions the custom-domain route/certificate during deployment; wait for HTTPS readiness.

Set local `vars.PUBLIC_ORIGIN` to the selected **actual HTTPS origin only**: no path, query, fragment, credentials or trailing slash. Replace every deployment placeholder; no `.example.com` hostname should remain in your active configuration.

Edit `r2-cors.local.json`: replace the example origin with the exact canonical origin and include any other hostname actually serving your app. `http://localhost:5173` is optional for development. Keep methods **GET, PUT, HEAD**, allowed headers `*`, and exposed header **ETag** (needed for multipart completion). Do not replace the origins with `*`.

```bash
npx wrangler r2 bucket cors set itransfer-files --file r2-cors.local.json -c wrangler.local.jsonc
npx wrangler r2 bucket lifecycle set itransfer-files --file r2-lifecycle.json -c wrangler.local.jsonc
```

The supplied lifecycle rule aborts incomplete multipart uploads after seven days; it does not expire completed files. Preserve the hourly `0 * * * *` cron in local Worker configuration for application cleanup. Do **not** add `limits.cpu_ms`: Workers Free rejects an explicit CPU limit. Minification is recommended and included below.

In Cloudflare Dashboard → R2 → Manage R2 API Tokens, create **Object Read & Write** credentials scoped to this bucket. Save the returned **Access Key ID** and **Secret Access Key**, plus the account's hexadecimal **Account ID**, privately. These S3-compatible credentials sign browser-to-R2 transfers; they are **not** Wrangler's OAuth login or an ordinary Cloudflare user API token. The bucket need not be publicly readable.

## 4. Prepare secrets before the first deployment

Create the protected file without overwriting an existing one. Stop if `.dev.vars` already exists or is a symlink:

```bash
test ! -e .dev.vars && test ! -L .dev.vars && install -m 600 .dev.vars.example .dev.vars
```

Fill `.dev.vars` in a private editor, saving credentials in a password manager. This is dotenv syntax, **not a shell script**: never `source` or `eval` it. Quote values containing `#` or whitespace with dotenv-compatible quotes; embedded quotes need appropriate escaping. Do not paste secrets into command arguments, public terminals/recordings, logs or issues.

| Setting | What to supply |
|---|---|
| `SESSION_SECRET` | Generate 32 random bytes as 64 hexadecimal characters; save this stable credential root separately from database backups. |
| `ADMIN_EMAIL` | Your own first administrator email. |
| `ADMIN_PASSWORD` | A unique 8–128-character password that passes common-password/pattern rejection; a long password-manager-generated password is recommended. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The bucket-scoped S3 credentials from step 3. |
| `R2_ACCOUNT_ID` | Your Cloudflare account ID, not the database UUID or access key ID. |
| `API_BEARER_TOKEN` | Optional independent random 64-hex token; leave blank to disable the automation API. It grants global access across **all users' files**, not a per-user scope. |
| `NTFY_URL` | Optional private ntfy-compatible endpoint; otherwise blank. |
| `TRANSACTIONAL_MAIL_API_URL`, `TRANSACTIONAL_MAIL_API_KEY` | Configure together in step 5, or leave **both blank** for private manual setup/reset links. |

Generate the root (and separately the optional bearer token) on a trusted, unrecorded terminal, then store the output privately:

```bash
openssl rand -hex 32
```

Startup requires nonempty `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, with a minimum 32-character root. That validation does **not** prove R2 credentials work; the three R2 values are functionally necessary for transfers. Never put secrets in `--var`, `VITE_*`, source code or public configuration. Root `.dev.vars` is read by local Wrangler, not the frontend Vite bundle; do not copy secrets into frontend environment files.

## 5. Optional mail: configure now, or use manual links

Mail is optional: account creation, password setup/recovery and transfers work with privately delivered manual links. This repository **does not deploy a mail service or grant access to the maintainer's private service**.

For mail, bring or separately deploy a compatible TransactionalMailer API: HTTPS `POST /v1/emails`, bearer authentication, `Idempotency-Key`, raw JSON `{to,subject,text,expires_at}`, and a compatible `202` response with message ID/status. The app credential needs **raw-mail permission**; template/catalog permission alone is insufficient. iTransfer sends plain text and **never HTML**. This is not a plug-and-play SMTP, Resend or SendGrid credential field. See the [API reference](API.md) and [mail contract](USER-MANAGEMENT.md#catalog-selection-and-plain-text-exception).

If you have this service, create a protected, gitignored `transactional.key` in your editor with only these assignments (illustrative placeholders, not usable credentials):

```dotenv
TRANSACTIONAL_MAIL_API_URL=https://mailer.example.com
TRANSACTIONAL_MAIL_API_KEY='<app-scoped-key>'
```

Replace the hostname with your service's HTTPS origin and the placeholder key with the operator-issued key. The helper requires the actual `tm_live_…` key format; an arbitrary token will fail validation. Keep this file mode 0600 and never display it publicly.

```bash
chmod 600 transactional.key
npm run mail:configure
```

This updates **local `.dev.vars` only**, preserving unrelated settings. Do it before step 6 so the first deployment includes the two mail secrets. With no service, skip the helper and leave both mail settings blank.

When configured, welcome/reset mail is mandatory and cannot be opted out of. All five **optional** preferences default to false: `share_downloads`, `request_uploads`, `password_changed`, `expiry_alerts`, `invitation_reminders`. Users manage them in My Account; administrators can manage them in Users. Optional preferences do not disable mandatory mail. There is no email-verification workflow.

## 6. Deploy once, atomically with secrets

Review the local database UUID, bucket names, canonical origin, CORS and all secrets. Check that the Worker name is unused. Then run:

```bash
npm run deploy -- -c wrangler.local.jsonc --minify --secrets-file .dev.vars
```

The pinned Wrangler **4.116.0** accepts an env/JSON secrets file and installs those secrets with the first deployment. This avoids attempting `secret put` on a nonexistent Worker or publishing an intentionally broken, secretless app. The npm command first builds the frontend.

**Use `--secrets-file` only for this new-installation bootstrap.** It is additive: omitted secrets are not deleted, while supplied stale values overwrite current ones. Later deployments normally use:

```bash
npm run deploy -- -c wrangler.local.jsonc --minify
```

For a deliberate later secret change, use the protected interactive prompt, for example `npx wrangler secret put NTFY_URL -c wrangler.local.jsonc`; do not put the value on the command line. Later mail enablement/rotation can use `npm run mail:configure -- --remote --config wrangler.local.jsonc` with the protected key file: it updates Worker mail secrets, sends no email, and needs no app redeploy. Keep local and remote values synchronized deliberately, not by replaying an old bootstrap file.

## 7. First sign-in, users and recovery

1. Open your reviewed HTTPS origin and sign in with the exact `ADMIN_EMAIL`/`ADMIN_PASSWORD` you installed. With empty `users` and no bootstrap marker, this creates the first active administrator. There is no public signup or separate account wizard. Initial bootstrap sends **no welcome/reset email**.
2. Confirm your identity/role in the UI (or the browser's authenticated `/api/auth/me` response) and that **Users** is available. Default sessions last **90 days**. A compliant fresh password avoids the legacy `password_change_required` restriction; if prompted, change your own password and sign in again.
3. In Users, create a **second administrator**, then a first ordinary **user**, using controlled addresses and confirming your password when prompted. Each starts pending with a **24-hour, single-use** password-setup link. Deliver manual links only through a trusted private channel if mail is absent or fails. The recipient chooses an 8–128-character compliant password and then signs in.
4. Setup tokens travel in `/set-password#token=…`; first-party JavaScript captures/removes the fragment and submits the proof/token in the request body. Treat links and proof bodies as passwords: never copy them into logs, screenshots, public tickets or analytics. Browser PBKDF2 uses 600,000 iterations; that work is **not Worker CPU time**.
5. Test recovery on the controlled ordinary account: an administrator issues a **one-hour** reset link. Issuance immediately revokes **all** target sessions and replaces prior setup links; redemption is single-use. Mail is mandatory when configured, otherwise use the private manual link. Confirm the old sessions no longer work and the user can sign in with the new password.

Mail failure does not roll back account creation/reset. If the user already exists, **do not recreate it or blindly resend an `unknown` submission**; it may already be queued. Inspect the sanitized status, use a still-valid private fallback, or have an administrator deliberately issue a new link. An invalid HTTPS `PUBLIC_ORIGIN` returns `503` before link issuance.

After bootstrap, database credentials are authoritative. Changing `ADMIN_PASSWORD` in the environment is **not recovery**. Do not wipe users or the bootstrap marker. Do not regenerate `SESSION_SECRET`: root rotation requires controlled account resets, not ordinary maintenance. See [credential-root guidance](USER-MANAGEMENT.md#credential-root-and-rotation) and [recovery](USER-MANAGEMENT.md#operator-recovery-without-an-http-bypass).

## 8. Verify the installed application

Replace the example hostname below with your **actual reviewed origin** before running these unauthenticated checks (no credentials needed):

```bash
curl -i https://files.example.com/health
curl -i https://files.example.com/ready
curl -i https://files.example.com/api/users
curl -i https://files.example.com/api/cost/estimate
```

Expect `200`, `200`, `401`, `401`. Health/readiness are shallow checks: **not proof of database, R2 or mail operation**. Complete the browser checks too:

- [ ] All migrations applied; first administrator and second administrator can sign in.
- [ ] Upload a tiny disposable file, share it, and download it as the intended recipient in a separate browser session.
- [ ] Create a file request and complete a recipient upload; check the owner's received file. Test a small folder upload too.
- [ ] The ordinary user sees only their own workspace/files; cross-user access is denied and administrator-only Costs returns `403` to an ordinary user. Test only accounts/data you control.
- [ ] Password recovery invalidates old sessions and setup-link replay fails. No secret/link/proof is exposed in shared diagnostic output.
- [ ] If mail is enabled, verify welcome/reset arrival at a **controlled inbox**. API `202` means queued, not SMTP/inbox delivery. Optional events stay off until opted in.
- [ ] Cron appears in the deployment/dashboard; root backup is safely stored separately from D1 backups. Optional controlled multipart testing verifies exposed `ETag`; a 500 MB upload is not required for the basic smoke test.

## Troubleshooting and maintenance

| Symptom | Check/action |
|---|---|
| Missing D1 / all-zero placeholder ID | Use `-c wrangler.local.jsonc`; check account and the newly created UUID, never substitute an existing database blindly. |
| `no such table` | Apply **all** migrations to the correct remote DB; verify no pending migrations. |
| Startup `503` / short root | Check required secrets and root length privately; do not rotate a populated installation's root to troubleshoot. |
| Password-change gate / `403` | Complete the required own-password change and sign in again; do not clear its database flag. |
| `/api/auth/me` returns `401` | Without a valid cookie this is expected; old/revoked cookies require a fresh sign-in. |
| Mail absent / `401` / quota / `unknown` | Check both settings, app-key validity, raw permission and provider quota/status. HTML-template-only providers are incompatible. Do not blindly retry uncertain delivery; use controlled manual fallback. |
| Upload/signature/CORS failure | Check exact served origin, GET/PUT/HEAD, exposed ETag, R2 account/key permissions, and matching bucket names in binding and vars. |
| Account-link `503` / wrong link host | Correct `PUBLIC_ORIGIN` to the reviewed real HTTPS origin before issuing a new link. |
| Workers `1102` / CPU termination | Profile the full request path and cold starts. Free compatibility is not a performance guarantee; do not weaken password protections or automatically upgrade plans. See [measured limitations](USER-MANAGEMENT.md#deployment-and-rollback). |

For later changes, use the [upgrade/backup/rollback runbook](USER-MANAGEMENT.md#deployment-and-rollback): D1 restores metadata, **not deleted R2 bytes**. Optional local validation: `npm test`, `npm run typecheck`, `npm run build:frontend`; browser setup and `npm run test:ui` are in [README tests](../README.md#tests). Synthetic tests do not prove production transfers or email delivery.

Source of truth: [scripts/dependencies](../package.json), [public Worker config](../wrangler.jsonc), [secret template](../.dev.vars.example), [CORS](../r2-cors.json), [lifecycle](../r2-lifecycle.json), [account logic](../src/lib/accounts.ts), [user routes](../src/routes/users.ts), [mail transport](../src/lib/mail.ts), and [mail helper](../scripts/configure-mail.mjs). This guide documents the installation procedure; it is not a claim that a fresh live installation was performed during documentation review.
