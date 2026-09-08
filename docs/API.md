# Programmatic API (`/api/v1/`)

**Last updated:** 2026-09-08

Bearer-token endpoints for scripts and agents. All requests use:

```
Authorization: Bearer $API_BEARER_TOKEN
Content-Type: application/json
```

Errors return `{"detail": "message"}` with an appropriate HTTP status.

**Credential boundary:** `API_BEARER_TOKEN` is a global automation credential, not a per-user token. These endpoints retain global share/request access and global cost reporting. They do not implement session workspace isolation and cannot administer users or create browser sessions. Keep the token with trusted operators, never ordinary workspace users. Bearer-created content is attributed to the bootstrap administrator once bootstrapped; ownerless legacy content is backfilled on bootstrap. Disabling that administrator or revoking browser sessions does not revoke the independent bearer secret; rotate/remove it separately. Workspace headers below apply only to session routes, not `/api/v1/`.

## Shares

### Create a share

Three steps, in order: **create → upload bytes → confirm**. Do not confirm until every upload returned HTTP 200.

**1. `POST /api/v1/shares`** → `201`

```json
{
  "files": [{"filename": "report.pdf", "size": 123456, "content_type": "application/pdf"}],
  "title": "Optional title",
  "id_format": "animals",        // "animals" (default) or "random"
  "id_length": 10,               // random format only, 4–64
  "expiry_days": 30,             // optional, fractional allowed; default 365
  "max_downloads": 5,            // optional
  "password": "secret"           // optional
}
```

Response: `share_id`, `share_url`, and per file either `upload_url` (PUT the bytes to it) or, for files >100 MB, `multipart.upload_id` + `multipart.parts[]` (PUT each 50 MB slice to its `upload_url`, collect the `ETag` response headers).

**2. Upload the bytes** with plain `curl -X PUT --data-binary @file "$UPLOAD_URL"`.

For multipart files, complete after uploading all parts:

`POST /api/v1/shares/{share_id}/complete-multipart`

```json
{"file_id": "...", "upload_id": "...", "parts": [{"part_number": 1, "etag": "\"...\""}]}
```

**3. `POST /api/v1/shares/{share_id}/confirm`** - verifies every object landed in R2 and activates the share.

### Manage shares

| Endpoint | Effect |
|---|---|
| `GET /api/v1/shares` | List all shares |
| `GET /api/v1/shares/{id}` | Share detail incl. files |
| `PATCH /api/v1/shares/{id}` | `{"expiry_days": 30}` extends from now; `{"is_paused": true}` hides temporarily (404 for recipients, files kept) |
| `POST /api/v1/shares/{id}/download` | Presigned download URLs (bypasses password, counts as a download) |
| `DELETE /api/v1/shares/{id}` | Deactivate + delete R2 objects |
| `DELETE /api/v1/shares/{id}/purge` | Hard-delete all records too |

## File requests

| Endpoint | Effect |
|---|---|
| `POST /api/v1/requests` | Create (`title` required; optional `message`, `expiry_days`, `max_uploads`, `max_file_size`, `allow_incremental`, `password`, `id_format`, `id_length`) → `201` with `request_url` |
| `GET /api/v1/requests` | List all requests |
| `GET /api/v1/requests/{id}` | Detail incl. uploaded files |
| `PATCH /api/v1/requests/{id}` | `{"expiry_days": 14}` extends from now |
| `POST /api/v1/requests/{id}/download` | Presigned download URLs for uploaded files |
| `DELETE /api/v1/requests/{id}` | Deactivate + delete R2 objects |
| `DELETE /api/v1/requests/{id}/purge` | Hard-delete all records too |

## Cost

`GET /api/v1/cost` returns global R2 estimates to the trusted bearer credential. The browser equivalent, `GET /api/cost/estimate`, requires an administrator session; ordinary users cannot access it.

- Aggregate fields include `total_storage_bytes`, `total_files`, `active_shares`, `active_requests`, `total_downloads`, `window_days`, `class_a_ops_month`, `class_b_ops_month`, `gross_monthly_cost_usd`, `free_tier_savings_usd`, `estimated_monthly_cost_usd`, `breakdown` and `estimate_note`.
- `users[]` contains `user_id`, `name`, `email`, `total_storage_bytes`, `total_files`, `class_a_ops_month`, `class_b_ops_month` and **gross** `gross_monthly_cost_usd`.
- Only the aggregate deducts **one shared free tier**, assumed entirely available. Per-user gross amounts are not individual bills. This is **R2 only**, excluding Workers/D1 operation fees, optional paid-plan charges and every other part of the Cloudflare bill. Workers Free is the required baseline, not a zero-cost/availability guarantee: its 100,000 requests/day limit and D1 daily read/write and storage quotas apply. Quota exhaustion can interrupt service and is not modeled by this estimate.
- Storage counts confirmed files under active shares/requests, including paused shares, not historical GB-days or verified bucket inventory. Unconfirmed uploads and inactive history are excluded; failed deletions can leave uncounted R2 objects.
- Operations estimate confirmations, public/API share download events and request download URL issuance over 30 days. Actual reads, retries, HEADs, workspace share downloads and abandoned multipart uploads are not fully measured. Durable usage survives content purges; historical backfill uses file creation dates and cannot reconstruct already-purged usage or past request downloads. Legacy unassigned usage resolves to the bootstrap administrator.

## Browser authentication and account administration

These are **session endpoints**, not bearer API extensions. Mutations require an `Origin` header matching the request URL origin, including login and password setup. Account JSON bodies are capped at 8 KiB; unknown fields are rejected. Responses are non-cacheable. Public user objects contain `id`, `email`, `name`, `role`, `status`, `created_at`, `updated_at`, `last_login_at` and boolean `password_change_required`; no password or token hashes are returned.

| Endpoint | Body / result |
|---|---|
| `POST /api/auth/password-challenge` | Exactly one of `{email}` or `{token}` → `{salt,iterations:600000,bootstrap}`; public salt parameters, no email-account existence flag |
| `POST /api/auth/login` | `{email,proof,bootstrap_password?}` → public user and opaque session cookie; raw `bootstrap_password` only for first eligible bootstrap |
| `GET /api/auth/me` | Current public user; session required |
| `POST /api/auth/logout` | Revokes only the current session |
| `POST /api/auth/reauth` | `{proof}` → credential confirmation for this session, valid for five minutes |
| `POST /api/auth/password` | `{current_proof,new_proof}` → revokes all sessions and setup tokens; sign in again |
| `POST /api/auth/setup-password` | `{token,proof}` → consumes invitation/reset capability, activates account and revokes all target sessions/tokens; clears the browser session and does not log in |
| `GET /api/users` | Admin only → `{users:[...]}` |
| `GET /api/users/audit` | Admin only → `{events:[...]}`, latest 200 account/workspace audit events |
| `POST /api/users` | Admin + recent confirmation; `{name,email,role?}` (`user` default) → `201` with `{user,setup_url,expires_at,mail}`; pending account, mandatory plain-text welcome with 24-hour setup link |
| `PATCH /api/users/{id}` | Admin + recent confirmation; subset of `{name,email,role,status}`; roles `admin`/`user`, requested statuses `active`/`disabled` → public user |
| `POST /api/users/{id}/reset-password` | Admin + recent confirmation → `{setup_url,expires_at,mail}`; mandatory plain-text reset, one-hour token replacing prior link and immediately revoking all target sessions |
| `POST /api/users/{id}/revoke-sessions` | Admin + recent confirmation → revokes all target sessions |

### Client-stretched account protocol

1. Request `/api/auth/password-challenge` with `{email}` for login/reauth/password change, or `{token}` for invitation/reset setup. Email challenges return public parameters for known and unknown emails without account existence/status flags. `bootstrap` is a **global** empty-users/no-marker flag, not an email match. Token challenges require a valid, unexpired setup capability; invalid links return `400`.
2. Decode the 32-character hex `salt` to 16 bytes. In the browser, derive 256 bits with native WebCrypto PBKDF2-SHA256, **600,000 iterations**, using the UTF-8 password. Encode the result as 64 lowercase hex characters (`proof`). Use the returned salt, not one recomputed from the current email: each account's persisted salt survives email changes and resets. For password changes derive both proofs with that salt.
3. Submit the proof fields above over TLS. Only during eligible empty-users/no-marker bootstrap does the client additionally submit the raw configured password as `bootstrap_password`. An exact configured credential match authorizes installing the proof without recomputing PBKDF2. If that password fails the new policy, one-time compatibility still accepts it but sets `password_change_required: true`; a compliant password sets `false`. Existing-account login rejects `bootstrap_password`; there is no environment/legacy fallback after bootstrap.

The Worker runs native HKDF-SHA256 to derive a pepper key from `SESSION_SECRET`, then HMAC-SHA256 over a versioned tuple binding user ID, persisted salt and proof. D1's `password_hash` stores `client-pbkdf2-sha256$600000$<hmac-hex>`, **not the proof**. This provides offline-guessing protection against a **D1-only** leak while the high-entropy root remains secret; it does not protect a stolen proof or a combined root/database compromise. There is **no server-side account password KDF**.

Proofs are **replayable password-equivalent credentials**, not nonce-bound challenge responses. Never log them, place them in URLs or persist them in local/session storage or caches. First-party password setup/change enforces 8–128 characters and common-password rejection in the browser. Normal Worker endpoints can validate only fixed-format 256-bit proof input: they cannot attest password quality or KDF work by malicious clients. Native browser WebCrypto requires HTTPS or a localhost secure context.

`SESSION_SECRET` must be high-entropy material: generate 32 random bytes encoded as 64 hex characters. The runtime's 32-character minimum does not establish entropy. It is coupled to stored verifiers and rate-limit keys; rotation invalidates verifiers and requires controlled resets, not legacy fallback. Sessions remain opaque D1-backed cookies with a **90-day default**, not root-signed cookies. See [root rotation](USER-MANAGEMENT.md#credential-root-and-rotation).

Challenges have a separate admission policy: IP **120/15 minutes, 400/hour**; identity **60/15 minutes, 200/hour**. Workers Free remains the deployed plan. The isolated hosted checks had no runtime failures but included four requests over **10 ms**, so they do not prove strict CPU-budget compliance. See [release observations](USER-MANAGEMENT.md#release-status-2026-09-08); occasional Free bursts and a short successful production monitor do not guarantee general workload reliability.

### Required password change

When `password_change_required` is true, session-authenticated workspace routes, user administration and `/api/cost/estimate` return **403** with `X-Password-Change-Required: 1` and `Cache-Control: no-store`. The independent global bearer API is not converted into a restricted browser session.

The restricted session may use only:

- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/reauth`
- `POST /api/auth/password`
- `GET /api/auth/email-preferences`
- `PATCH /api/auth/email-preferences`

Public challenge/login and token-authorized `/api/auth/setup-password` remain available under their existing checks; setup requires a valid reset/setup capability, not merely a restricted session. Successful own-password change or reset clears the stored flag and revokes sessions; sign in again. The first-party repair form uses the existing password to derive `current_proof` and the new policy-compliant password for `new_proof`. Ordinary browser policy and 600,000-iteration stretching are unchanged. Initial bootstrap sends no reset email.

Reactivating a passwordless account returns it to `pending`, not passwordless `active`; issue a fresh setup link. Disabled accounts cannot redeem links. Email, role, status or password changes invalidate all sessions and setup tokens. The last active administrator cannot be disabled/demoted; account deletion is not supported.

Setup URLs use `https://itransfer.example.com/set-password#token=...`: the browser receives the fragment and submits the token in JSON, not the URL query. Links are emailed in plain text and returned for controlled manual fallback. iTransfer validates `PUBLIC_ORIGIN` as an HTTPS origin before creating accounts, rotating tokens or revoking sessions; invalid configuration returns 503 without those changes. The UI also treats missing or malformed fallback links as unusable and disables copying them. Recipients come from current D1 account state, not caller-supplied mail headers. There is **no email verification/confirmation workflow**.

### Email preferences and submission

| Endpoint | Authorization |
|---|---|
| `GET/PATCH /api/auth/email-preferences` | Active session; own preferences regardless of selected workspace |
| `GET /api/users/{id}/email-preferences` | Administrator reads target preferences |
| `PATCH /api/users/{id}/email-preferences` | Administrator + recent proof changes target preferences |

`welcome: true` and `password_reset: true` are always-on response fields; attempts to change them are rejected. All five optional booleans are implemented and default to `false`: `share_downloads`, `request_uploads`, `password_changed`, `expiry_alerts`, `invitation_reminders`. PATCH accepts a nonempty subset of optional booleans, preserving omitted values. See [event meanings](USER-MANAGEMENT.md#transactional-email-and-preferences). Download mail says “A download was started”: capability issuance is not evidence that file bytes were fully downloaded. Password-change mail follows successful password changes and reset redemption, not reauthentication or initial setup.

`POST /api/users/{id}/invitation` requires recent admin proof, a pending account and `invitation_reminders` opt-in. It returns `{setup_url,expires_at,mail}` with a fresh 24-hour setup link replacing the previous one; the UI warns explicitly before issuance. Ineligible accounts return `409`; optional-admission denial returns `429` with `Retry-After: 300` and does not replace the existing link. Account creation sends only the mandatory welcome, never an extra automatic invitation email.

Account responses include `mail: {status,message_id?,error_code?}`, where status is `queued`, `failed`, `unknown` or `not_configured`. `queued` means service acceptance, **not delivery**. `unknown` may already be accepted: never blindly resend with a new key. Account creation/reset is not rolled back by mail failure. There is no local durable outbox; a crash between D1 commit and POST requires deliberate admin recovery with a fresh link, or controlled manual delivery of a still-valid returned URL.

iTransfer posts permission-gated raw `{to,subject,text,expires_at}` to service `/v1/emails` with bearer authentication and `Idempotency-Key`; it sends neither `html` nor `template`. The frozen body/expiry/key are reused for at most two attempts (one retry for network/timeout/5xx uncertainty), **4.5 seconds per attempt**. Rejected requests are not blindly retried. Queue expiry is at most 15 minutes and before setup-token expiry; it differs from the 24-hour/one-hour token lifetime.

Optional mail is best-effort background work, never a reason to fail completed file flows. Atomic claims deduplicate for seven days and cap optional admission at one per user per five minutes, five per user per hour and ten globally per UTC day. This leaves nominal headroom of 15 under the service's 25/app/day quota for mandatory mail, not a delivery reservation. Failed attempts can consume admission. See [mail operations](USER-MANAGEMENT.md#mail-configuration-and-key-rotation).

Authentication errors use `401`, authorization/recent-proof failures `403`, conflicting admin changes `409`, and quota denial `429` with `Retry-After: 900`. Expired proof includes `X-Reauth-Required: 1`; confirm the password for this session before retrying. Password and rate-limit policies and operator recovery are documented in [User management](USER-MANAGEMENT.md).

## Session workspaces

`/api/shares` and `/api/requests` require a session and default to the caller's private workspace. Creation is `POST /api/shares/init` and `POST /api/requests`; other detail, update, confirm, multipart and download operations remain owner-scoped. Foreign object IDs return `404` without granting access.

Administrators can send `X-Workspace-User: <user-id>` to select another workspace. Omitting `X-Workspace-Mode` gives **read-only view**. Explicit `X-Workspace-Mode: manage` allows writes with a password confirmation less than five minutes old. Ordinary users cannot select another workspace. The authenticated actor remains the administrator, not the target user, and cross-workspace attempts/outcomes are audited.

Read-only view permits GET/HEAD and allowlisted download POSTs (including individual share-file downloads). Those download routes issue capabilities: “read-only” does **not** mean administrators cannot read file bytes. View mode forbids upload, confirmation, update, deletion and purge. See [workspace semantics](USER-MANAGEMENT.md#roles-and-workspaces).

## Public endpoints (no auth)

Used by the web UI; also callable directly:

- `GET /api/public/shares/{id}` - metadata (file list hidden if password-protected)
- `POST /api/public/shares/{id}/unlock` - `{"password": "..."}` → file list
- `POST /api/public/shares/{id}/download` - `{"password": "..."}` (if protected) → download URLs, increments the counter
- `GET /api/public/requests/{id}` - request metadata
- `POST /api/public/requests/{id}/upload` - same body as share files → upload URLs
- `POST /api/public/requests/{id}/complete-multipart` - as above
- `POST /api/public/requests/{id}/confirm` - `{"file_ids": [...], "message": "optional"}`

Password endpoints lock out after 3 failed attempts per 15 minutes.
