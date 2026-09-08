# Persistent backend regression tests

Run from the repository root after installing the project dependencies:

```sh
npm test
# Equivalent:
node --test --test-concurrency=1 tests/*.test.mjs

# Focus on a suite or one regression:
node --test tests/auth.test.mjs
node --test --test-concurrency=1 --test-name-pattern='concurrent' tests/*.test.mjs

# Three independent complete executions for stability evidence:
for run in 1 2 3; do npm test || exit 1; done
```

`npm test` runs `node --test --test-concurrency=1 tests/*.test.mjs`. Test files run
serially; concurrency regressions still dispatch simultaneous requests within
their isolated fixtures. The harness uses the project's installed esbuild and
Miniflare dependencies. Account authentication has no server-side password KDF
or noble dependency.
Dependency versions are maintained in `package.json` and the lockfile, not here.
The tests do not install packages or modify package manifests. Use a current Node
version supported by those dependencies. No `node:sqlite` experimental runtime
is required.

## Isolation and fidelity

- `helpers/worker.mjs` bundles **the real `src/index.ts`**, once per test-file
  process, with esbuild `write: false`. Nothing is written to `dist/`.
- Each top-level test has a fresh Miniflare/workerd instance, an isolated D1
  database and R2 bucket with persistence disabled. `t.after` always disposes it.
- Only synthetic `.example.test` origins, email addresses, passwords, R2 signing
  credentials and a documentation-range client IP are supplied explicitly.
- No Wrangler configuration, `.dev.vars`, Cloudflare account or remote D1/R2
  database is read. Worker outbound fetches are intercepted and fail closed.
- The real on-disk SQL migrations run in filename order. The migration lexer
  preserves quoted semicolons, comments, CASE expressions and whole trigger
  bodies; every complete statement is passed to `D1.prepare` in a batch.
  **Do not replace this with `D1.exec(multilineSQL)` or `split(';')`.**
  Migration-only tests use a minimal non-HTTP Worker: they exercise real D1 SQL
  without needing to bundle application dependencies. Every HTTP test bundles
  the actual application.
- Authorization-denial fixtures additionally wrap the bucket binding with a
  test-only observer that rejects and counts every call (including HEAD and
  swallowed cleanup errors). Seed data still uses the real fixture R2 bucket.
  This proves foreign IDs are rejected before bucket access, rather than merely
  checking that the final response happens to be 404.
- Users and opaque session-token hashes are normally seeded directly in D1.
  Each fixture user has a random, persisted 16-byte credential salt. Node's
  `proofFor(salt, password)` independently implements the **client's** PBKDF2
  SHA-256 at **600,000 iterations**, cached by salt/password; the Worker receives
  the resulting 64-hex proof, not a regular plaintext password. `verifierFor`
  independently implements native HKDF/HMAC with the specified domain-separation
  salts/info and JSON `[version, userId, salt, proof]` binding. Only that keyed
  verifier is stored at rest, never the proof. Bootstrap alone submits the raw
  initial environment secret to authorize installing the initial proof.
- `challenge({email})` / `challenge({token})` explicitly exercise the challenge
  wire contract. `login(email, password)` obtains a challenge and sends a proof,
  adding `bootstrap_password` only when bootstrap is open. The generic request
  helper never silently translates legacy password bodies: regression tests
  assert they are rejected.
- All auth and rate-limit fixtures intercept WebCrypto `deriveBits` and
  `deriveKey`: any **PBKDF2** request is counted, rejected, and fails teardown.
  Native HKDF/HMAC remains untouched. This protects the account path's Workers
  Free CPU design; it is not a CPU benchmark or a claim about legacy public
  share-password code, which is outside this guard's scope.
- Rate-limit tests seed pseudonymous attempt rows for quota boundaries, then
  exercise actual HTTP admission. They do not run hundreds of expensive KDFs.
- Concurrency tests dispatch simultaneous requests to workerd against its D1,
  not mocks of SQL or an unrelated SQLite implementation.

## Regression contracts

| Suite | Contracts |
| --- | --- |
| `migrations.test.mjs` | Multiline-trigger migration handling, account deletion guard, immutable salt, same-verifier reset revocation and last-admin protection |
| `auth.test.mjs` | Concurrent bootstrap and legacy owner backfill, 90-day cookie, client proofs and account-bound HKDF/HMAC verifiers, challenge contract, raw-password rejection, proof validation, verifier transplant rejection, cross-account reauth denial, salt stability after email change, old-root reset recovery, session generation/expiry/logout, invite/reset fragments, token expiry/replay/concurrent same-proof redemption, recent-auth header, concurrent last-admin demotion |
| `rate-limit.test.mjs` | Exact login/reauth/recovery/admin/challenge account and IP windows, last-slot concurrency, cross-session user-wide reauth ceiling, login/invalid-recovery exhaustion isolated from legitimate challenges, administration and recovery |
| `workspace.test.mjs` | Owner-only lists and object access, foreign file/multipart IDs, unchanged R2 objects after denials, expected-user mismatch rejection before creation/storage, admin view versus manage/recent-auth, audit attribution, nonadmin costs/users denial, bearer global costs but no session/user management |
| `cost.test.mjs` | Active confirmed storage only, paused storage retained, per-user gross reconciliation, globally applied free tier, 30-day operations window, usage survives content purge, historical migration backfill idempotency |

`ui-multiuser.mjs` belongs to the separate frontend/browser suite and is not
selected by the backend `*.test.mjs` glob.

## Reporting limitations

These are real-runtime security and accounting regression tests, not complete
endpoint or branch coverage. Node's `--experimental-test-coverage` cannot report
coverage of JavaScript executing in the separate workerd process; it primarily
measures the Node harness. Do not claim 80% Worker coverage from that report.
Signed URL tests validate capability issuance; they do not contact live R2 or
upload multi-gigabyte files. Large cost fixtures use metadata sizes and tiny
synthetic R2 payloads deliberately. Browser behavior is covered separately.

If a security contract fails while production code is being developed, preserve
the failing assertion and report the actual HTTP response. Do not skip a test,
mock the Worker implementation, lower PBKDF2 rounds or relax a 403/404 contract
merely to make the run green.
