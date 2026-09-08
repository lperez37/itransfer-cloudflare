# User management and operator runbook

**Last updated:** 2026-09-08

Implementation sources: [`accounts.ts`](../src/lib/accounts.ts), [session authorization](../src/lib/auth.ts), [auth routes](../src/routes/auth.ts), [user routes](../src/routes/users.ts), [workspace authorization](../src/lib/workspace.ts), and [hourly cleanup](../src/scheduled.ts). See also the [README](../README.md) and [API reference](API.md).

For a fresh deployment, follow the ordered [first-time installation guide](INSTALLATION.md). This runbook covers ongoing administration, security details, upgrades and recovery.

## Roles and workspaces

- `user`: manage only their own shares, requests and files. Ownership is checked server-side, including file and multipart operations, not merely hidden in the UI.
- `admin`: their own private workspace plus account administration, global cost reporting and explicit access to other workspaces.
- Another workspace opens read-only by default. Administrators can download files in view mode. Explicit **manage** mode plus recent password confirmation is required for mutations. This is delegated administration, not impersonation: the administrator remains the actor and the owner remains the target.
- Cross-workspace access records attempt and outcome events; denied writes are audited. Audit detail uses route templates rather than raw capability-bearing paths, bodies or signed URLs.
- User states are `pending`, `active`, `disabled`. There is no account deletion API, and D1 prevents deleting accounts or disabling/demoting the last active administrator.
- Disabling an account blocks its login and invalidates sessions/setup links. It does not itself delete its files or revoke existing public share/request links; manage those separately when offboarding. The global automation bearer secret is also independent.

## Invitations, passwords and sessions

1. An administrator creates an account with name, email and role. It starts pending.
2. Mandatory plain-text welcome mail explains sharing, file requests, private workspaces and public-link precautions, with a **24-hour** setup link. The returned URL supports private manual fallback on mail failure. Welcome cannot be opted out of; it is not email confirmation.
3. The recipient opens `/set-password#token=...`, chooses a password and then signs in. The token is in the fragment, not the request URL/query; redemption submits it in JSON.
4. For recovery, an administrator issues a **one-hour** reset link and mandatory plain-text reset mail, which cannot be opted out of. Issuance replaces prior setup tokens and immediately revokes all target sessions. Redemption is single-use and invalidates remaining sessions/setup tokens.

Tokens are 32 cryptographically random bytes encoded as 64 lowercase hexadecimal characters. Only SHA-256 token digests are stored in D1. Treat raw links as passwords: do not put them in tickets, analytics, screenshots, command history or logs.

The [first-party browser](../frontend/src/lib/credentials.ts) enforces **8–128 characters** and common-password/pattern rejection when choosing a new password. It requests a public salt challenge, decodes its 16-byte salt and uses native WebCrypto **PBKDF2-SHA256 with 600,000 iterations** to derive a **256-bit proof**, transmitted as 64 lowercase hex characters. WebCrypto requires a secure context: HTTPS in production or localhost for development. Account salts are persisted and survive email changes and resets; clients must use the challenge salt rather than derive one from the email.

The Worker performs **native HKDF + peppered HMAC**, not an account password KDF. Its HMAC binds the proof to the user ID and persisted salt. The `password_hash` column stores `client-pbkdf2-sha256$600000$<hmac-hex>`; D1 stores **no proof**. A D1-only leak cannot support offline proof verification without the secret pepper root. This protection depends on keeping the root separate and does not cover combined database/root compromise.

**Security boundary:** the Worker accepts only fixed-format 256-bit proofs on normal account endpoints; it cannot attest password quality or that a malicious client performed the required PBKDF2 work. Browser policy is not server enforcement. Only the one-time bootstrap flow receives and validates the raw configured password server-side. A proof is a **replayable password equivalent**, not a nonce-bound response: require TLS and never put proofs in URLs, logs, audit records, caches, localStorage or sessionStorage. Keep them transient within the credential flow.

Sessions are opaque bearer cookies with SHA-256 digests in `user_sessions`; D1 checks account status, expiry and session generation on each authenticated request. Default lifetime is **90 days**, configurable with `SESSION_MAX_AGE_DAYS`. Cookies are HttpOnly, SameSite=Lax and Secure on HTTPS. Old signed cookies are intentionally invalid: users must sign in again.

- Logout revokes **only the current session**.
- Changing a password revokes **all sessions, including the caller**, and all setup links.
- Changes to email, role or status also revoke every session/setup link through a database trigger.
- Explicit session revocation increments the generation, protecting against concurrent login based on an older snapshot.
- Sensitive admin writes require password proof within **five minutes**, tied to the current session. A new login supplies initial proof; later confirm with `/api/auth/reauth`.

## Transactional email and preferences

Delivery integration is implemented in [`mail.ts`](../src/lib/mail.ts). **Every iTransfer email is plain text only, never HTML.** Mandatory welcome and password-reset submissions ignore optional preferences. Account creation sends only welcome, not an additional invitation email. There is no email-confirmation state or verification message.

Own preferences use `GET/PATCH /api/auth/email-preferences`: the active authenticated user is always the target, regardless of workspace view/manage context. Administrators use `GET/PATCH /api/users/{id}/email-preferences`; changes require recent proof. `welcome` and `password_reset` always return `true`; the API rejects changing them.

All five optional booleans below are implemented, deployed and default to `false`. Deployment is not evidence of inbox delivery; no real mail was sent in release validation. PATCH accepts a nonempty subset of optional booleans and preserves omitted preferences.

| Optional boolean | Event semantics | Source status |
|---|---|---|
| `share_downloads` | “A download was started” for an owned share: capability issuance, **not proof of completed file download** | Implemented |
| `request_uploads` | Finalized uploads to an owned request, not upload URL issuance | Implemented |
| `password_changed` | After successful password change/reset redemption, not reauthentication or initial password setup | Implemented |
| `expiry_alerts` | Hourly owner-scoped warning for active resources expiring within 24 hours; shares must be confirmed | Implemented |
| `invitation_reminders` | Explicit admin `POST /api/users/{id}/invitation` for an opted-in pending account; recent proof and fresh 24-hour link replacing the old link, with an explicit UI warning | Implemented |

The reminder is deliberate, not automatic on creation or a blind retry of uncertain welcome submission. Implemented optional transfer mail runs best-effort in the background. Recipients and ownership come from current D1 state, never arbitrary request addresses or mail headers. Atomic claims deduplicate events and cap optional admission at **one per user per five minutes, five per user per hour, ten globally per UTC day**. Against the provider's 25/app/day quota, this leaves nominal headroom of 15 for mandatory mail, not reserved capacity. Claims last seven days and contain no recipient/body/capability; even failed or subsequently suppressed claimed attempts consume admission. Email failures must not fail completed file flows.

### Catalog selection and plain-text exception

The service's private source contract (`docs/templates.md` and `docs/integrations.md`, updated 2026-09-08) exposes authenticated public HTTPS `GET /v1/templates`, filtered by app permissions. The supported seven-ID catalog informed this selection:

| Catalog ID | iTransfer semantic use |
|---|---|
| `new-user` | Mandatory welcome explaining the app with initial setup link |
| `password-reset` | Mandatory administrator-issued recovery |
| `notification` | Optional download-capability/finalized-upload events |
| `invitation` | Pending-account reminder contract above |
| `password-changed` | Optional post-change/reset notice contract above |
| `alert` | Optional resource-expiry warning contract above, not an invented storage-threshold monitor |
| `email-verification` | Excluded: no email-confirmation workflow |

**These are semantic mappings, not provider template IDs submitted by iTransfer.** All canonical templates generate both text and HTML, with no format-selection flag. iTransfer therefore intentionally uses permission-gated raw `{to,subject,text,expires_at}`, locally authored plain-text messages and **no `html` field**. The service app needs explicit raw-mail permission; catalog access alone does not prove it.

Template URL rules enforce allowed HTTPS origins and permit setup-link fragments. Raw text does not get that template-specific origin enforcement: iTransfer checks its configured HTTPS `PUBLIC_ORIGIN` and constructs `/set-password#token=...` itself. Review that intended origin; never accept arbitrary caller links or recipients.

### Submission is not delivery

The Worker posts to `/v1/emails` with bearer authentication, JSON and a stable idempotency key. `202` is queued/accepted, **not inbox delivery**; even provider `submitted` means SMTP acceptance, not confirmed delivery. Account responses return `mail.status` (`queued`, `failed`, `unknown`, `not_configured`) and optional sanitized message ID/error code. Never log raw response text, recipients, keys, proofs or setup links.

The transport freezes the body, token, expiry and key across **one bounded retry**, **4.5 seconds per attempt**, for network/timeout/5xx uncertainty. Rejection is not permission to generate a fresh key and resend. `unknown` may already be queued; investigate instead. Queue expiry is capped at 15 minutes and before token expiry with a margin; this is separate from the account's 24-hour/one-hour link lifetime.

The provider queues durably, but **iTransfer has no local outbox**. Account creation/reset commits before mail submission; failure never rolls it back. A crash between commit and POST cannot recover a frozen body locally: an admin must deliberately issue a fresh link, invalidating the old one. A still-valid returned URL supports trusted manual delivery. Invalid `PUBLIC_ORIGIN` returns 503 before account creation or token/session changes. The UI also refuses to copy a missing or malformed fallback URL; correct configuration instead of making arbitrary links.

## Mail configuration and key rotation

Set `TRANSACTIONAL_MAIL_API_URL` to an HTTPS origin such as `https://mailer.example.com`, with no endpoint path, userinfo, query or fragment. Keep `TRANSACTIONAL_MAIL_API_KEY` in Worker secrets/protected local configuration, not browser code. Both settings are separate from the account credential root.

The gitignored private `transactional.key` file is env-style and contains only these two assignments. [`scripts/configure-mail.mjs`](../scripts/configure-mail.mjs) validates it without shell evaluation:

```bash
npm run mail:configure
# Optional alternate protected input:
npm run mail:configure -- --file transactional.key
```

Default mode atomically updates local `.dev.vars` with mode **0600**, preserving unrelated secrets/comments. `npm run mail:configure` invokes `scripts/configure-mail.mjs`; direct Node invocation is equivalent. The script's explicit `--remote` option invokes Wrangler **secret bulk**, with `--config wrangler.local.jsonc` by default; it updates remote mail secrets and **does not deploy**. Do not use remote mode for local configuration/probing.

Service keys normally expire after **90 days**. Rotation adds a new key with overlap: install and verify it before revoking the old key. Queued messages remain bound to their original key; premature revocation can block delivery admission. Coordinate queue state with the service operator. **Never rotate or rewrite `SESSION_SECRET` during mail-key maintenance**: it is a different secret rooting account verifiers.

Use isolated local tests and an authenticated **GET** of `/v1/templates` over public HTTPS, injecting the key through a protected runtime channel. This checks key/catalog access, not submission or delivery. Production mail settings are installed, but no real email test or live mail POST was performed during release validation. Run `npm test` and `npm run test:ui` for subsequent changes and report actual results.

**Recorded mail verification, 2026-09-08:** local configuration was installed without displaying credentials and the authenticated public catalog probe returned all seven IDs without sending mail. Authorized deployment subsequently installed the two production mail settings while retaining existing secrets, including the unchanged account credential root. Automated mail tests use an isolated fake provider. See the final [release evidence](#release-status-2026-09-08); actual SMTP/inbox delivery has not been tested.

## Credential root and rotation

`SESSION_SECRET` now couples credential verification and pseudonymous rate-limit keys. Generate **32 cryptographically random bytes**, encoded as **64 hex characters** (for example, the README's `openssl rand -hex 32` secret-setup command). The runtime enforces at least 32 characters, but cannot prove entropy. Store the root securely and separately from D1 backups.

**Do not casually rotate this secret to revoke sessions.** It derives the HMAC pepper; changing it invalidates all stored account password verifiers and requires controlled account resets. It is not a cookie-signing key: sessions are opaque, and rotation alone does not revoke existing D1 sessions. Use explicit session revocation for that purpose.

Plan root replacement under maintenance with verified backup/access, explicit session revocation, and controlled reset-token issuance/redemption under the new root. Preserve existing account salts; do not clear the bootstrap marker or re-enable environment/legacy password fallback. If no administrator can authenticate after replacement, use the [privileged recovery ceremony](#operator-recovery-without-an-http-bypass) to restore an administrator, then reset the remaining accounts. The implementation has no automatic verifier rewrapping, dual-root fallback or general-purpose rotation tool.

## Authentication and rate limits

Admission happens atomically before server credential verification. Browser password stretching is outside Worker execution. Limits below are **15-minute / one-hour** windows, not failed-attempt counters; success never clears them.

| Namespace | IP quota | Identity quota |
|---|---|---|
| Password challenge | 120 / 400 | Email/token challenge identity: 60 / 200 |
| Login | 30 / 100 | Normalized email: 8 / 20 |
| Reauthentication / password change | 60 / 180 | Session-bound user identity: 20 / 60; additional cross-session user ceiling: 60 / 180 |
| Valid recovery capability | 30 / 100 | Separate token identity: 8 / 20 |
| Invalid/expired recovery | 10 / 30 | Separate invalid-token identity: 8 / 20 |
| Admin writes | 120 / 400 | Administrator identity: 60 / 200 |

Separate namespaces prevent anonymous login exhaustion from consuming authenticated proof or legitimate recovery budgets. IP/email keys are HMAC-pseudonymized using `SESSION_SECRET`. Quota denial returns `429`, `Retry-After: 900` and non-cacheable responses. Login failures are generic; unknown users still run native dummy HMAC verification, not a password KDF. Account bodies must be JSON, at most 8 KiB, with only accepted fields. Unsafe methods require same-origin `Origin`, including unauthenticated challenge/login/setup.

## Bootstrap

The first **correct** login using `ADMIN_EMAIL` and `ADMIN_PASSWORD` can create the first active administrator only when both conditions hold:

- `users` is empty;
- `app_settings` has no `bootstrap_admin_id` marker.

`POST /api/auth/password-challenge` accepts exactly `{email}` or `{token}` and returns `{salt,iterations:600000,bootstrap}`. Email challenges have no account existence/status flags: `bootstrap` describes the global empty-users/no-marker state, independent of the supplied email. A token challenge validates the setup capability and returns its account salt.

Only when bootstrap is open does the first-party client send `{email,proof,bootstrap_password}`. The Worker requires an exact match to the configured credentials. **One-time migration compatibility accepts that exact existing password even if it fails the new 8–128-character/common-password policy**, setting the persisted flag and public boolean `password_change_required: true`. A compliant bootstrap password sets `false`. This is not a general weak-password option or later environment fallback. Knowledge of the initial secret authorizes installing the proof; the Worker does **not** recompute PBKDF2 to check its relationship to the raw password. Administrator insertion, salt/verifier, restriction flag, durable marker, legacy owner backfill and audit commit in one D1 batch.

A restricted account cannot access workspaces, user administration or session cost reports: these return `403` with `X-Password-Change-Required: 1`. It may inspect `/api/auth/me`, log out, reauthenticate, change its own password, and read/update its own email preferences. Public challenge/login and capability-authorized password setup retain their normal checks. The full method/path allowlist is in the [API reference](API.md#required-password-change).

**First-login repair:** sign in with the existing configured password, then use that old password as the current password and choose a new browser-policy-compliant password. Successful change (or valid reset redemption) clears the flag and revokes sessions; sign in again before accessing the workspace. Browser policy and native PBKDF2-SHA256 at 600,000 iterations remain unchanged for new passwords. Initial bootstrap sends no reset email. Do not clear the flag manually as a workaround.

Normal login is `{email,proof}`; reauthentication is `{proof}`; password change is `{current_proof,new_proof}`; setup is `{token,proof}`. Existing-account login rejects the bootstrap password field. See the [API protocol](API.md#client-stretched-account-protocol).

After bootstrap, D1 credentials are authoritative. Environment credentials are still required by startup validation, but changing them **never resets a password or restores access**. Do not delete the marker, clear users, disable triggers or revive legacy cookie/password fallback. Bearer authentication is not a bootstrap path.

## Deployment and rollback

The release below is deployed. This checklist remains the operator procedure for future installations/upgrades; it is not authorization to repeat remote operations.

1. Use Node 22.19+ and install root/frontend dependencies. Run `npm test`, `npm run test:ui`, typechecking and the frontend build. Browser dependencies and the Nix Chromium executable override are documented in the [README](../README.md#tests). Tests are not hosted performance evidence.
2. **Workers Free compatibility is required.** Test complete flows on isolated hosted Free staging with disposable data. Measure Worker CPU separately from browser stretching/wall time and assess cold execution, errors, concurrency and quota behavior against the **10 ms budget**. Record exceedances honestly: the deployed release did not pass a strict all-requests-under-10-ms criterion.
3. Native server HKDF/HMAC avoids account password stretching on the Worker, but does not establish full-path CPU compliance. Public share/request password handling retains its legacy **100,000-iteration server PBKDF2**; not every password path avoids Worker KDF cost. Occasional Free CPU bursts are allowed, not guaranteed capacity. Review exceedances and reliability risk before rollout without weakening browser PBKDF2 or requiring a plan upgrade. Monitor Free's **100,000 requests/day** and D1 quotas; exhaustion can interrupt service. See measured release observations below.
4. Establish an operator-controlled D1 backup/restore point and a plan to preserve R2 objects. Verify the intended database/bucket/configuration and backup access. Arrange a maintenance window to prevent old and new binaries serving writes during cutover.
5. Apply migrations in order **before serving the new application**: [`0004_users.sql`](../migrations/0004_users.sql) adds accounts/ownership/security state; [`0005_cost_usage.sql`](../migrations/0005_cost_usage.sql) adds usage/storage views; [`0006_cost_backfill.sql`](../migrations/0006_cost_backfill.sql) seeds retained usage; [`0007_email_preferences.sql`](../migrations/0007_email_preferences.sql) adds preferences/claims. **0004–0007 are now deployed and immutable. Never edit applied migrations; use a new forward migration for changes.** New installations apply them in order with earlier prerequisites. Do not split trigger SQL naively at semicolons.
6. For a reviewed private configuration, the migration command is `npm run db:migrate:remote -- -c wrangler.local.jsonc`; the subsequent deployment command is `npm run deploy -- -c wrangler.local.jsonc`. These are instructions only; do not run them until the backup, staging benchmark and maintenance checks pass.
7. Complete the first sign-in with the configured bootstrap credential and any required own-password repair. Verify the administrator, marker and legacy ownership; old cookies must be rejected. Create a second administrator and test recovery, isolation, audited view/manage mode and administrator-only costs.

Treat these migrations as **forward-only**. Prefer a tested forward fix. **Do not restore a pre-user legacy binary against the populated multi-user database:** its global authorization model can bypass workspace isolation. Any full rollback requires an explicitly reviewed, coordinated pre-migration data/application restore under maintenance, sacrificing intervening changes. A D1 restore restores metadata only: it **does not restore deleted R2 bytes**. Account for content cleanup/deletion before promising recoverability.

## Release status 2026-09-08

The following production evidence was supplied by the authorized operator; this documentation update did not repeat deployment, retrieve credentials or send mail.

- **Cutover complete:** the minified full application is deployed on both configured origins, on the unchanged Workers Free plan. Migrations 0004–0007 are applied and immutable. Existing secrets were inherited, the credential root was unchanged, and the two transactional-mail settings were installed remotely.
- **Data preservation:** a protected D1 backup and restore-integrity check preceded maintenance/schema application. Existing record counts remained unchanged. The operator retains the backup in `<protected-backup-dir>`; do not publish real backup paths, identifiers or business record counts. A D1 restore still cannot restore deleted R2 bytes.
- **Local checks:** 97 backend tests and 51 browser scenarios passed, along with typecheck and build. Lint reported zero errors and one existing Fast Refresh warning. Mail tests used a fake provider; no actual SMTP message was sent.
- **Isolated hosted Free checks:** 71 checks, zero runtime failures. CPU median **4 ms**, p95 **11 ms**, maximum **20 ms**; **four exceeded 10 ms**, including cold execution. These results are **not a strict 10 ms validation pass**. Native Free permits occasional bursts, but sustained load, cold starts and other workloads remain reliability risks. No plan upgrade was made.
- **Live HTTPS probes:** health/readiness returned `200`, unauthenticated protected API access returned `401`, and wrong-origin CSRF probes returned `403` on the configured origins.
- **Post-deployment observation:** over 90 seconds, 45 monitored events had outcome `ok`, maximum CPU **7 ms**, zero over 10 ms and no CPU termination. This short observation does not guarantee general workload performance or erase the isolated exceedances.
- **Bootstrap still outstanding at release check:** the global bootstrap flag remained `true` and no user account had yet been created. The operator must perform the first sign-in, then complete required password repair if prompted. No production login credentials were retrieved and no initial bootstrap reset email was sent.

## Operator recovery without an HTTP bypass

**Preferred:** maintain a second active administrator. That administrator confirms their password and issues a one-hour reset link through normal account administration. There is no environment-password fallback, no unauthenticated recovery endpoint that issues links, and currently no supported offline reset CLI in this implementation. Do not invent or depend on one; future tooling may automate the ceremony below.

If all administrators are locked out, an authorized operator with controlled D1 access can manually issue a reset capability. This is privileged database maintenance, not an ordinary user procedure:

1. Enter maintenance, verify the deployment/database and take an operator-controlled backup. Secure the maintenance host and inspect the chosen account's ID, role and status. This recipe requires an existing **active administrator**; stop if none exists rather than bypassing status/last-admin protections.
2. On the trusted host, independently generate 32 cryptographically random bytes and encode them as 64 lowercase hex characters. Compute SHA-256 over the UTF-8 bytes of that **hex token string**, producing a 64-character lowercase hex digest. Keep the raw token only in protected memory/secret storage for handoff. Never pass it in SQL, command-line arguments, shell history or logs. This is a token digest, **not** a PBKDF2 password hash.
3. Prepare the following statements with bound values, using reviewed operator-controlled D1 access. Execute them together as **one atomic D1 batch**, not separate console submissions. The repository currently supplies no operator runner for this; arrange a reviewed maintenance runner capable of parameter binding and `DB.batch` before proceeding. Do not publish it as an HTTP fallback.

```sql
-- Bind :user_id to the verified active administrator UUID.
-- :token_hash is the SHA-256 digest only, NEVER the raw token.
-- :now = current UTC epoch seconds; :expires = :now + 3600.
-- :iso_now = current UTC ISO timestamp. Named binds are illustrative;
-- adapt placeholders to the maintenance driver's actual binding API.
INSERT INTO password_tokens(token_hash,user_id,expires_at,created_at)
SELECT :token_hash,id,:expires,:now FROM users
WHERE id=:user_id AND role='admin' AND status='active'
ON CONFLICT(user_id) DO UPDATE SET
  token_hash=excluded.token_hash,
  expires_at=excluded.expires_at,
  created_at=excluded.created_at
RETURNING user_id;

UPDATE users SET session_generation=session_generation+1,updated_at=:iso_now
WHERE id=:user_id AND EXISTS (
  SELECT 1 FROM password_tokens WHERE user_id=:user_id AND token_hash=:token_hash
);

DELETE FROM user_sessions WHERE user_id=:user_id AND EXISTS (
  SELECT 1 FROM password_tokens WHERE user_id=:user_id AND token_hash=:token_hash
);

INSERT INTO account_audit(actor_id,target_id,action,detail,created_at)
SELECT NULL,id,'account.operator_reset_issued','Authorized offline recovery',:iso_now
FROM users WHERE id=:user_id AND EXISTS (
  SELECT 1 FROM password_tokens WHERE user_id=:user_id AND token_hash=:token_hash
);
```

4. Verify the batch committed and returned exactly the intended user, old sessions are gone and the new expiry is one hour. If issuance returned no user, stop and investigate; do not change role/status/marker to force this recipe through. Record operator identity and approval in the controlled incident record without any token or link. Avoid logging SQL parameter values, including token digests.
5. Privately construct `https://itransfer.example.com/set-password#token=<raw-token>` using the actual reviewed public origin. Allow the legitimate account holder to redeem through the normal HTTPS setup page, then sign in. The normal password update trigger consumes the token and revokes all sessions. Verify successful recovery and rejection of replay, then remove the protected temporary capability material and end maintenance.

Never directly install a plaintext/weak password, weaken the KDF, use a legacy binary, remove the bootstrap marker, or add an insecure HTTP recovery route. If the controlled atomic-batch procedure cannot be performed safely, remain in maintenance and obtain reviewed recovery tooling.

## Reporting and retention

The administrator cost view reports gross per-user R2 estimates and a global estimate after a **single shared free tier**. It is not a full Cloudflare bill: Workers/D1 operation fees, optional paid-plan charges and quota-exhaustion effects are excluded. R2 operation fees are approximated, not fully metered. Free deployment does not guarantee zero R2 charges or uninterrupted service within daily platform quotas. Storage is a current logical snapshot, and operations are approximate rolling 30-day application events. Historical gaps and missing operations are described in [API cost limitations](API.md#cost).

Hourly cleanup prunes expired sessions/setup tokens, old authentication attempts and aged account audit records in bounded batches, independently of content cleanup. Expiry checks take effect on requests without waiting for cron. Durable cost usage is retained independently of share/request/download history purges. Audit is operational history, not an indefinitely retained external compliance archive.
