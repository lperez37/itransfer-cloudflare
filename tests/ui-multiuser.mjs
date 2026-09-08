/**
 * Mock-only browser regressions. No real accounts, storage, or backend are used.
 * Run: node tests/ui-multiuser.mjs
 * Requires Playwright + Chromium and frontend dependencies. Starts local Vite.
 * Optional: UI_BASE_URL (existing Vite server), PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
 * UI_SCREENSHOT_DIR optionally captures final Users/Costs desktop/mobile images.
 * Password screenshots default to /tmp/opencode/itransfer-password-toggle;
 * UI_SCREENSHOT_DIR (or SCREENSHOT_DIR) overrides that directory.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { pbkdf2Sync } from "node:crypto";

const base = process.env.UI_BASE_URL || "http://127.0.0.1:5187";
let server;
let browser;
let serverOutput = "";
const admin = {
  id: "admin-1",
  name: "Demo Admin",
  email: "admin@example.com",
  role: "admin",
  status: "active",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  last_login_at: null,
};
const member = {
  ...admin,
  id: "member-1",
  name: "Morgan Member",
  email: "morgan@example.com",
  role: "user",
};
const completion = "/api/shares/upload-share/complete-multipart";
const confirmShare = "/api/shares/upload-share/confirm";
const recoveryFixture = `https://files.example.test/set-password#token=${"a".repeat(64)}`;
const invitationFixture = (number) =>
  `https://files.example.test/set-password#token=${number.toString(16).padStart(64, "0")}`;
const optionalEmailKeys = [
  "share_downloads",
  "request_uploads",
  "password_changed",
  "expiry_alerts",
  "invitation_reminders",
];
const defaultEmailPreferences = {
  share_downloads: false,
  request_uploads: false,
  password_changed: false,
  expiry_alerts: false,
  invitation_reminders: false,
  welcome: true,
  password_reset: true,
};
const salts = {
  [admin.email]: "00112233445566778899aabbccddeeff",
  [member.email]: "ffeeddccbbaa99887766554433221100",
};
const saltFor = (email) =>
  salts[email?.trim().toLowerCase()] || salts[member.email];
const fixtureProof = (password, salt) =>
  pbkdf2Sync(password, Buffer.from(salt, "hex"), 600000, 32, "sha256").toString(
    "hex",
  );
const correctProofs = Object.fromEntries(
  Object.values(salts).map((salt) => [
    salt,
    fixtureProof("correct-password", salt),
  ]),
);
const costFixture = {
  total_storage_bytes: 16 * 1024 ** 3,
  total_files: 160,
  estimated_monthly_cost_usd: 0.09,
  gross_monthly_cost_usd: 0.246716,
  free_tier_savings_usd: 0.156716,
  window_days: 30,
  class_a_ops_month: 248,
  class_b_ops_month: 14000,
  active_shares: 12,
  active_requests: 4,
  total_downloads: 860,
  breakdown: { storage: 0.09, requests_put: 0, requests_get: 0, transfer: 0 },
  estimate_note:
    "Estimates only. Shared R2 allowances apply once across all workspaces; other services are excluded.",
  users: [
    {
      user_id: admin.id,
      name: admin.name,
      email: admin.email,
      total_storage_bytes: 12 * 1024 ** 3,
      total_files: 128,
      class_a_ops_month: 180,
      class_b_ops_month: 12000,
      gross_monthly_cost_usd: 0.18561,
    },
    {
      user_id: member.id,
      name: member.name,
      email: member.email,
      total_storage_bytes: 4 * 1024 ** 3,
      total_files: 32,
      class_a_ops_month: 68,
      class_b_ops_month: 2000,
      gross_monthly_cost_usd: 0.061106,
    },
  ],
};

async function until(check, message) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function scenario(name, run, width = 1400) {
  const context = await browser.newContext({
    viewport: { width, height: 950 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const calls = [];
  const errors = [];
  const unexpectedRequests = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      (url.origin !== new URL(base).origin ||
        /\/(?:mail|emails?|send-email)(?:\/|$)/i.test(url.pathname))
    )
      unexpectedRequests.push(`${url.origin}${url.pathname}`);
  });
  const state = {
    identity: admin,
    deny: new Map(),
    hold: new Map(),
    responseHold: new Map(),
    initialized: [],
    reauthIdentity: null,
    accounts: [{ ...admin }, { ...member }],
    loginIdentity: member,
    passwordProofs: new Map(),
    cost: structuredClone(costFixture),
    bootstrap: false,
    challengeOverride: undefined,
    createMail: { status: "queued", message_id: "welcome-message" },
    resetMail: { status: "queued", message_id: "reset-message" },
    invitationMail: { status: "queued", message_id: "invitation-message" },
    invitationsIssued: 0,
    recoveryOverride: null,
    preferences: new Map(),
    publicRequest: false,
  };
  page.on("pageerror", (error) => errors.push(error.message));
  const matching = (path) => calls.filter((call) => call.path === path);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON();
    calls.push({ path, method, headers: request.headers(), body });
    if (state.hold.has(path)) await state.hold.get(path).promise;
    let status = 200;
    let data = { detail: "OK" };
    const headers = {};
    const denial = state.deny.get(path);
    const expected = request.headers()["x-expected-user"];
    if (expected && expected !== state.identity?.id) {
      status = 401;
      headers["X-Identity-Mismatch"] = "1";
      data = { detail: "Session identity changed" };
    } else if (
      state.identity?.password_change_required &&
      /^\/api\/(shares|requests|users|cost)(\/|$)/.test(path)
    ) {
      status = 403;
      headers["X-Password-Change-Required"] = "1";
      data = { detail: "Change your password before using your workspace" };
    } else if (denial?.remaining > 0) {
      denial.remaining--;
      status = denial.status || 403;
      data = {
        detail: denial.detail || "Password confirmation required",
        code: "REAUTH_REQUIRED",
      };
      if (denial.marked !== false) headers["X-Reauth-Required"] = "1";
    } else if (
      path === "/api/auth/email-preferences" ||
      /^\/api\/users\/[^/]+\/email-preferences$/.test(path)
    ) {
      const target = path.startsWith("/api/users/")
        ? path.split("/")[3]
        : state.identity.id;
      if (path.startsWith("/api/users/") && state.identity.role !== "admin") {
        status = 403;
        data = { detail: "Administrator access required" };
      } else {
        const preferences = state.preferences.get(target) || {
          ...defaultEmailPreferences,
        };
        if (method === "PATCH") {
          assert(
            Object.keys(body).every((key) => optionalEmailKeys.includes(key)),
            "Mandatory preferences must never be posted",
          );
          assert(
            Object.values(body).every((value) => typeof value === "boolean"),
          );
          Object.assign(preferences, body);
        }
        state.preferences.set(target, preferences);
        data = preferences;
      }
    } else if (path.startsWith("/api/public/")) {
      // Only these read-only fixtures are supported; never unlock or upload.
      status = 404;
      data = { detail: "Not found" };
      if (method === "GET" && path === "/api/public/shares/visible-test" && !state.publicRequest) {
        status = 200;
        data = {
          id: "visible-test", title: "Protected test share", file_count: 1,
          files: [], password_required: true, expires_at: "2099-01-01T00:00:00Z",
          downloads_remaining: 5,
        };
      } else if (method === "GET" && path === "/api/public/requests/visible-test" && state.publicRequest) {
        status = 200;
        data = {
          title: "Protected test request", password_required: true,
          remaining_uploads: 5, expires_at: "2099-01-01T00:00:00Z", files: [],
        };
      }
    } else if (path === "/api/auth/me") {
      data = state.identity || { detail: "Not authenticated" };
      status = state.identity ? 200 : 401;
    } else if (path === "/api/auth/password-challenge") {
      assert.equal(Object.keys(body).length, 1);
      assert("email" in body || "token" in body);
      data = state.challengeOverride ?? {
        salt: saltFor(body.email),
        iterations: 600000,
        bootstrap: !!body.email && state.bootstrap,
      };
      headers["Cache-Control"] = "no-store";
    } else if (path === "/api/auth/reauth") {
      if (
        body.proof !==
        (state.passwordProofs.get(state.identity.email) ??
          correctProofs[saltFor(state.identity.email)])
      ) {
        status = 401;
        data = { detail: "Invalid password" };
      } else if (state.reauthIdentity) state.identity = state.reauthIdentity;
    } else if (path === "/api/auth/logout") {
      state.identity = null;
    } else if (path === "/api/auth/login") {
      if (
        body.proof !==
        (state.passwordProofs.get(body.email) ??
          correctProofs[saltFor(body.email)])
      ) {
        status = 401;
        data = { detail: "Invalid credentials" };
      } else {
        state.bootstrap = false;
        state.identity = state.loginIdentity;
        data = state.identity;
      }
    } else if (path === "/api/auth/password") {
      if (
        body.current_proof !==
        (state.passwordProofs.get(state.identity.email) ??
          correctProofs[saltFor(state.identity.email)])
      ) {
        status = 401;
        data = { detail: "Invalid password" };
      } else {
        if (state.identity.password_change_required) {
          state.loginIdentity = {
            ...state.identity,
            password_change_required: false,
          };
          state.passwordProofs.set(state.identity.email, body.new_proof);
        }
        state.identity = null;
        data = { detail: "Password changed" };
      }
    } else if (path === "/api/auth/setup-password") {
      if (body.token !== "setup-token") {
        status = 400;
        data = { detail: "Invalid or expired setup link" };
      } else data = { detail: "Password saved" };
    } else if (path === "/api/users" && method === "GET") {
      data = { users: state.accounts };
    } else if (path === "/api/users" && method === "POST") {
      const created = { ...member, ...body, id: "new-user", status: "pending" };
      state.accounts.push(created);
      data = {
        user: created,
        setup_url: state.recoveryOverride
          ? state.recoveryOverride.value
          : recoveryFixture,
        expires_at: "2026-09-09T00:00:00Z",
        mail: state.createMail,
      };
    } else if (path.startsWith("/api/users/") && method === "PATCH") {
      const account = state.accounts.find(
        (row) => row.id === path.split("/").pop(),
      );
      Object.assign(account, body);
      data = account;
    } else if (/^\/api\/users\/[^/]+\/invitation$/.test(path)) {
      const target = path.split("/")[3];
      if (state.identity.role !== "admin") {
        status = 403;
        data = { detail: "Administrator access required" };
      } else if (
        state.accounts.find((row) => row.id === target)?.status !== "pending"
      ) {
        status = 409;
        data = {
          detail:
            "Invitation reminders are only available for pending accounts",
        };
      } else if (!state.preferences.get(target)?.invitation_reminders) {
        status = 409;
        data = {
          detail: "Enable invitation reminders in Email preferences first",
        };
      } else {
        state.invitationsIssued++;
        data = {
          setup_url: state.recoveryOverride
            ? state.recoveryOverride.value
            : invitationFixture(state.invitationsIssued),
          expires_at: "2026-09-09T00:00:00Z",
          mail: state.invitationMail,
        };
      }
    } else if (path.endsWith("/reset-password")) {
      data = {
        setup_url: state.recoveryOverride
          ? state.recoveryOverride.value
          : recoveryFixture,
        expires_at: "2026-09-09T00:00:00Z",
        mail: state.resetMail,
      };
      if (path === `/api/users/${state.identity?.id}/reset-password`)
        state.identity = null;
    } else if (path === "/api/cost/estimate") {
      data = state.cost;
    } else if (path === "/api/shares" || path === "/api/requests") {
      data = [];
    } else if (path === "/api/shares/init") {
      state.initialized.push({ actor: state.identity.id, expected, body });
      data = {
        share_id: "upload-share",
        files: [
          { file_id: "small-file", upload_url: `${base}/mock-r2/small` },
          {
            file_id: "large-file",
            multipart: {
              upload_id: "multipart-1",
              parts: [
                { part_number: 1, upload_url: `${base}/mock-r2/part-1` },
                { part_number: 2, upload_url: `${base}/mock-r2/part-2` },
              ],
            },
          },
        ],
      };
      data.files = data.files.slice(0, body.files.length);
    }
    const responseBody = JSON.stringify(data);
    if (state.responseHold.has(path))
      await state.responseHold.get(path).promise;
    await route
      .fulfill({
        status,
        body: responseBody,
        contentType: "application/json",
        headers,
      })
      .catch(() => {});
  });
  await context.route("**/mock-r2/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ path, method: request.method(), headers: request.headers() });
    await route.fulfill({
      status: 200,
      headers: { ETag: `"etag-${path.split("/").pop()}"` },
    });
  });
  try {
    await run({ page, context, state, calls, matching });
    assert.deepEqual(
      unexpectedRequests,
      [],
      "Frontend must not call email APIs or external services",
    );
    for (const call of calls.filter(
      (call) =>
        call.path.startsWith("/api/") && !call.path.startsWith("/api/public/"),
    )) {
      assert.equal(
        call.headers.authorization,
        undefined,
        "Backend service credentials must not be sent by the browser",
      );
      assert.equal(call.headers["x-api-key"], undefined);
      if (
        [
          "/api/auth/me",
          "/api/auth/login",
          "/api/auth/setup-password",
          "/api/auth/password-challenge",
        ].includes(call.path)
      )
        assert.equal(call.headers["x-expected-user"], undefined);
      else
        assert(
          call.headers["x-expected-user"],
          `Expected actor required for ${call.path}`,
        );
    }
    for (const call of calls.filter(
      (call) => call.path.startsWith("/api/auth/") && call.body,
    )) {
      const { body } = call;
      assert(
        !("password" in body) &&
          !("current_password" in body) &&
          !("new_password" in body),
        "Raw passwords must not be transmitted",
      );
      for (const field of ["proof", "current_proof", "new_proof"]) {
        if (field in body) assert.match(body[field], /^[a-f0-9]{64}$/);
      }
      if (
        [
          "/api/auth/login",
          "/api/auth/reauth",
          "/api/auth/setup-password",
        ].includes(call.path)
      )
        assert.match(body.proof, /^[a-f0-9]{64}$/);
      if (call.path === "/api/auth/password") {
        assert.match(body.current_proof, /^[a-f0-9]{64}$/);
        assert.match(body.new_proof, /^[a-f0-9]{64}$/);
      }
      if ("bootstrap_password" in body)
        assert.equal(call.path, "/api/auth/login");
    }
    assert.deepEqual(errors, [], "No browser runtime errors");
    console.log(`PASS ${name}`);
  } finally {
    for (const hold of state.hold.values()) hold.resolve();
    for (const hold of state.responseHold.values()) hold.resolve();
    await context.close();
  }
}

async function confirm(page, password = "correct-password") {
  await page.getByLabel("Your password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Confirm and continue" }).click();
}

async function checkToggle(input, showLabel, calls, hideLabel = showLabel.replace(/^Show/, "Hide")) {
  const page = input.page();
  await input.waitFor();
  assert.equal(await input.getAttribute("type"), "password", "Masked on mount");
  const id = await input.getAttribute("id");
  assert(id, "Password input has an explicit id");
  const button = page.getByRole("button", { name: showLabel, exact: true });
  assert.equal(await button.count(), 1);
  assert.equal(await button.getAttribute("aria-controls"), id);
  assert.equal(await button.getAttribute("type"), "button");
  assert.equal(await button.getAttribute("title"), showLabel);
  assert.equal(await button.getAttribute("aria-pressed"), null);
  assert.equal(await input.evaluate((el) =>
    [...el.labels].some((label) => label.htmlFor === el.id && !label.querySelector("button")),
  ), true, "Explicit field label must not contain the toggle");
  const attributes = await input.evaluate((el) =>
    Object.fromEntries(["id", "name", "required", "minlength", "maxlength", "autocomplete", "placeholder", "aria-describedby"]
      .map((name) => [name, el.getAttribute(name)])),
  );
  const mutations = () => calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method)).length;
  const before = mutations();
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await page.evaluate(() => {
    window.passwordToggleSubmits = 0;
    window.passwordToggleSubmitListener = () => window.passwordToggleSubmits++;
    document.addEventListener("submit", window.passwordToggleSubmitListener, true);
  });
  const original = await input.elementHandle();
  const value = "Toggle fixture passphrase 2026";
  await input.fill(value);
  await input.evaluate((el) => { el.focus(); el.setSelectionRange(2, 5); });
  await button.click();
  const hiddenAction = page.getByRole("button", { name: hideLabel, exact: true });
  await hiddenAction.waitFor();
  assert.equal(await input.getAttribute("type"), "text");
  assert.equal(await input.inputValue(), value);
  assert.equal(await input.evaluate((el, node) => el.isSameNode(node), original), true);
  assert.deepEqual(await input.evaluate((el) => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 2, 5]);
  assert.equal(await hiddenAction.getAttribute("title"), hideLabel);
  assert.equal(await hiddenAction.getAttribute("aria-pressed"), null);
  // Tab must reach the action; keyboard activation must keep focus there.
  await page.keyboard.press("Tab");
  assert.equal(await hiddenAction.evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press("Space");
  await button.waitFor();
  assert.equal(await input.getAttribute("type"), "password");
  assert.equal(await button.evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press("Enter");
  await hiddenAction.waitFor();
  assert.equal(await input.getAttribute("type"), "text");
  assert.equal(await hiddenAction.evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press("Space");
  await button.waitFor();
  assert.equal(await input.getAttribute("type"), "password");
  assert.equal(await input.inputValue(), value);
  assert.equal(await input.evaluate((el, node) => el.isSameNode(node), original), true);
  assert.deepEqual(await input.evaluate((el, names) =>
    Object.fromEntries(names.map((name) => [name, el.getAttribute(name)])), Object.keys(attributes)), attributes);
  const geometry = await button.evaluate((el) => {
    const field = document.getElementById(el.getAttribute("aria-controls"));
    const b = el.getBoundingClientRect();
    const i = field.getBoundingClientRect();
    return {
      width: b.width, height: b.height,
      inside: b.left >= i.left && b.right <= i.right + 1 && b.top >= i.top - 1 && b.bottom <= i.bottom + 1,
      reserved: parseFloat(getComputedStyle(field).paddingRight) >= i.right - b.left,
    };
  });
  assert(geometry.width >= 44 && geometry.height >= 40, "Toggle has a usable pointer target");
  assert(geometry.inside && geometry.reserved, "Toggle is inside the input with text space reserved");
  assert.equal(await page.evaluate(() => window.passwordToggleSubmits), 0, "Toggling never submits a form");
  assert.equal(mutations(), before, "Toggling never posts, unlocks, or uploads");
  assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), storage,
    "Password value and visibility are not persisted");
  await page.evaluate(() => document.removeEventListener("submit", window.passwordToggleSubmitListener, true));
  await original.dispose();
}

async function ownComposer(page) {
  await page.goto(`${base}/upload`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "alice-private.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Alice's private document"),
  });
  await page
    .getByPlaceholder("My awesome files")
    .fill("Alice private composer");
}

async function signIn(page, navigate = true) {
  if (navigate) await page.goto(`${base}/login`);
  await page.getByLabel("Email", { exact: true }).fill(member.email);
  await page.getByLabel("Password", { exact: true }).fill("correct-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
}

async function uploadManaged(page) {
  await page.goto(`${base}/users`);
  await page
    .getByRole("article")
    .filter({ hasText: member.email })
    .getByRole("button", { name: "View workspace" })
    .click();
  await page.getByRole("button", { name: "Enable management" }).click();
  await confirm(page);
  await page.getByRole("button", { name: "New Share", exact: true }).click();
  // Real File/Blob slicing exercises two multipart PUTs without disk fixtures.
  await page.locator('input[type="file"]').evaluate((input) => {
    const files = new DataTransfer();
    files.items.add(
      new File(["Small file"], "notes.txt", { type: "text/plain" }),
    );
    files.items.add(
      new File([new Uint8Array(50 * 1024 * 1024 + 7)], "large.bin", {
        type: "application/octet-stream",
      }),
    );
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.getByPlaceholder("My awesome files").fill("Keep this upload");
  await page.getByRole("button", { name: "Create Share", exact: true }).click();
}

function assertUpload(calls, matching, completions, confirms) {
  assert.equal(
    matching("/api/shares/init").length,
    1,
    "Never initialize another share",
  );
  assert.equal(matching("/api/shares/init")[0].body.title, "Keep this upload");
  assert.equal(
    calls.filter((call) => call.method === "PUT").length,
    3,
    "Each small file / multipart part uploaded exactly once",
  );
  assert.equal(matching(completion).length, completions);
  assert.equal(matching(confirmShare).length, confirms);
  const expected = {
    file_id: "large-file",
    upload_id: "multipart-1",
    parts: [
      { part_number: 1, etag: '"etag-part-1"' },
      { part_number: 2, etag: '"etag-part-2"' },
    ],
  };
  for (const call of matching(completion))
    assert.deepEqual(
      call.body,
      expected,
      "Identical file ID, upload ID, parts, and ETags",
    );
  for (const call of calls.filter((call) =>
    call.path.startsWith("/api/shares/"),
  )) {
    assert.equal(call.headers["x-workspace-user"], member.id);
    assert.equal(call.headers["x-workspace-mode"], "manage");
    assert.equal(call.headers["content-type"], "application/json");
  }
  for (const call of calls.filter((call) =>
    call.path.startsWith("/api/auth/"),
  )) {
    assert.equal(call.headers["x-workspace-user"], undefined);
    assert.equal(call.headers["x-workspace-mode"], undefined);
  }
}

// Test-only React consumer lets us exercise simultaneous requests, unmounts,
// and workspace changes without exposing debugging APIs in the shipped app.
async function harness(page) {
  await page.goto(`${base}/dashboard`);
  await page.getByRole("heading", { name: "Dashboard" }).waitFor();
  await page.evaluate(async () => {
    const { default: React } =
      await import("/node_modules/.vite/deps/react.js");
    const { default: ReactDOM } =
      await import("/node_modules/.vite/deps/react-dom_client.js");
    const { AuthProvider, useAuth } =
      await import("/src/context/AuthContext.tsx");
    const { WorkspaceProvider } =
      await import("/src/context/WorkspaceContext.tsx");
    const { useWorkspace } = await import("/src/context/workspace.ts");
    const host = document.createElement("div");
    document.body.append(host);
    document.getElementById("root").hidden = true;
    const root = ReactDOM.createRoot(host);
    function Controls() {
      const workspace = useWorkspace();
      const auth = useAuth();
      React.useEffect(() => {
        window.uiTest = {
          ...workspace,
          logout: auth.logout,
          unmount: () => root.unmount(),
        };
      }, [workspace, auth]);
      return null;
    }
    function SessionBound() {
      const { user } = useAuth();
      return user
        ? React.createElement(
            WorkspaceProvider,
            { key: user.id },
            React.createElement(Controls),
          )
        : null;
    }
    root.render(
      React.createElement(
        AuthProvider,
        null,
        React.createElement(SessionBound),
      ),
    );
  });
  await page.waitForFunction(() => !!window.uiTest);
  await page.evaluate((target) => window.uiTest.view(target, true), member);
  await page.waitForFunction(() => window.uiTest.target?.id === "member-1");
}

try {
  const assets = new URL("../frontend/dist/assets/", import.meta.url);
  const builtFiles = await readdir(assets).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of builtFiles.filter((file) => file.endsWith(".js"))) {
    const bundle = await readFile(new URL(file, assets), "utf8");
    assert(
      !/TRANSACTIONAL_MAIL_API_(?:KEY|URL)|MAILER_API_KEY|SMTP_PASSWORD/.test(
        bundle,
      ),
      "Server-only mail credential/config bindings must not enter the browser bundle",
    );
  }
  console.log(
    builtFiles.length
      ? "PASS built frontend excludes server-only mail credential/config bindings"
      : "SKIP bundle boundary check: build the frontend first",
  );
  if (!process.env.UI_BASE_URL) {
    server = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../frontend/node_modules/vite/bin/vite.js", import.meta.url),
        ),
        "--host",
        "127.0.0.1",
        "--port",
        "5187",
        "--strictPort",
      ],
      {
        cwd: fileURLToPath(new URL("../frontend/", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", (data) => {
      serverOutput += data;
    });
    server.stderr.on("data", (data) => {
      serverOutput += data;
    });
    await until(async () => {
      if (server.exitCode !== null) throw new Error(serverOutput);
      return fetch(base)
        .then((response) => response.ok)
        .catch(() => false);
    }, "Vite did not start");
  }
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });

  await scenario("login password toggle preserves typing, focus, semantics, and remount privacy", async ({ page, state, calls }) => {
    state.identity = null;
    await page.goto(`${base}/login`);
    const input = page.getByLabel("Password", { exact: true });
    await checkToggle(input, "Show password", calls);
    assert.equal(await input.getAttribute("autocomplete"), "current-password");
    await page.getByRole("button", { name: "Show password", exact: true }).click();
    await page.goto(`${base}/set-password#token=setup-token`);
    await page.getByLabel("New password", { exact: true }).waitFor();
    await page.goto(`${base}/login`);
    await input.waitFor();
    assert.equal(await input.getAttribute("type"), "password");
    assert.equal(await input.inputValue(), "");
  });

  for (const setup of [false, true]) {
    await scenario(`${setup ? "setup" : "account"} password fields toggle independently and preserve validation`, async ({ page, calls }) => {
      await page.goto(`${base}${setup ? "/set-password#token=setup-token" : "/account"}`);
      const fields = [
        ...(!setup ? [["Current password", "Show current password", "current-password"]] : []),
        ["New password", "Show new password", "new-password"],
        ["Confirm new password", "Show confirmed password", "new-password"],
      ];
      for (const [label, action, autocomplete] of fields) {
        const input = page.getByLabel(label, { exact: true });
        await checkToggle(input, action, calls);
        assert.equal(await input.getAttribute("autocomplete"), autocomplete);
        assert.equal(await input.evaluate((el) => el.required), true);
        if (autocomplete === "new-password") {
          assert.equal(await input.getAttribute("minlength"), "8");
          assert.equal(await input.getAttribute("maxlength"), "128");
        }
      }
      await page.getByRole("button", { name: "Show new password", exact: true }).click();
      for (const [label] of fields)
        assert.equal(await page.getByLabel(label, { exact: true }).getAttribute("type"), label === "New password" ? "text" : "password");
      assert.equal(await page.getByLabel("New password", { exact: true }).getAttribute("aria-describedby"), "password-hint");
    });
  }

  await scenario("confirmation toggle remounts masked and is disabled while reauthentication is pending", async ({ page, state, calls, matching }) => {
    await page.goto(`${base}/users`);
    const reset = page.getByRole("article").filter({ hasText: member.email })
      .getByRole("button", { name: "Reset password", exact: true });
    await reset.click();
    const input = page.getByLabel("Your password", { exact: true });
    await checkToggle(input, "Show password", calls);
    assert.equal(await input.getAttribute("autocomplete"), "current-password");
    await page.getByRole("button", { name: "Show password", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await reset.click();
    await input.waitFor();
    assert.equal(await input.getAttribute("type"), "password");
    assert.equal(await input.inputValue(), "");
    const gate = deferred();
    state.hold.set("/api/auth/reauth", gate);
    // Reject after release so the destructive admin action never runs.
    state.deny.set("/api/auth/reauth", { remaining: 1, status: 401, detail: "Test confirmation denied" });
    await confirm(page);
    await until(() => matching("/api/auth/reauth").length === 1, "Reauthentication reached its gate");
    const button = page.getByRole("button", { name: "Show password", exact: true });
    assert.equal(await input.isDisabled(), true);
    assert.equal(await button.isDisabled(), true);
    await button.evaluate((el) => el.click());
    assert.equal(await input.getAttribute("type"), "password");
    gate.resolve();
    await page.getByRole("alert").filter({ hasText: "Test confirmation denied" }).waitFor();
    assert.equal(await input.isEnabled(), true);
    assert.equal(await button.isEnabled(), true);
    assert.equal(matching(`/api/users/${member.id}/reset-password`).length, 0);
  });

  for (const [path, placeholder] of [
    ["/upload", "Protect your share with a password"],
    ["/requests/new", "Protect uploads with a password"],
  ]) {
    await scenario(`${path} optional password uses the shared action without creating or uploading`, async ({ page, calls }) => {
      await page.goto(`${base}${path}`);
      if (path === "/upload")
        await page.locator('input[type="file"]').setInputFiles({
          name: "toggle-fixture.txt", mimeType: "text/plain", buffer: Buffer.from("Mock only"),
        });
      await checkToggle(page.getByPlaceholder(placeholder, { exact: true }), "Show password", calls);
      assert.equal(calls.filter((call) => call.method === "PUT" || call.method === "POST").length, 0);
    });
  }

  for (const request of [false, true]) {
    await scenario(`public ${request ? "request" : "share"} password toggles without unlocking or uploading`, async ({ page, state, calls, matching }) => {
      state.identity = null;
      state.publicRequest = request;
      await page.goto(`${base}/visible-test`);
      await checkToggle(page.getByLabel(request ? "Password required to upload" : "Password", { exact: true }), "Show password", calls);
      // Vite's StrictMode replays the resolver's mount effect; the cancelled
      // first lookup does not continue to the request fallback.
      assert.equal(matching("/api/public/shares/visible-test").length, 2);
      assert.equal(matching("/api/public/requests/visible-test").length, request ? 1 : 0);
      assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
    });
  }

  await scenario("Dutch public password action is localized and remains private across reload", async ({ page, context, state, calls }) => {
    state.identity = null;
    await context.addInitScript(() => localStorage.setItem("lang", "nl"));
    await page.goto(`${base}/visible-test`);
    await page.getByRole("button", { name: "Wachtwoord tonen", exact: true }).waitFor();
    const input = page.getByLabel("Wachtwoord", { exact: true });
    await checkToggle(input, "Wachtwoord tonen", calls, "Wachtwoord verbergen");
    await page.getByRole("button", { name: "Wachtwoord tonen", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Wachtwoord tonen", exact: true }).waitFor();
    assert.equal(await input.getAttribute("type"), "password");
    assert.equal(await input.inputValue(), "");
    assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
      { local: { lang: "nl" }, session: {} });
  });

  await scenario("password controls desktop and mobile screenshot batch", async ({ page, state, calls }) => {
    const directory = process.env.UI_SCREENSHOT_DIR || process.env.SCREENSHOT_DIR || "/tmp/opencode/itransfer-password-toggle";
    await mkdir(directory, { recursive: true });
    for (const [name, path, width] of [
      ["password-login-desktop", "/login", 1400],
      ["password-account-desktop", "/account", 1400],
      ["password-modal-desktop", "/users", 1400],
      ["password-account-mobile", "/account", 390],
      ["password-public-mobile", "/visible-test", 390],
    ]) {
      state.identity = path === "/login" || path === "/visible-test" ? null : admin;
      await page.setViewportSize({ width, height: 950 });
      await page.goto(`${base}${path}`);
      if (path === "/users")
        await page.getByRole("article").filter({ hasText: member.email })
          .getByRole("button", { name: "Reset password", exact: true }).click();
      const label = path === "/account" ? "Show new password" : "Show password";
      if (width === 390)
        await checkToggle(page.getByLabel(path === "/account" ? "New password" : "Password", { exact: true }), label, calls);
      await page.getByRole("button", { name: label, exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true, animations: "disabled" });
    }
  });

  await scenario(
    "weak bootstrap enters account-only upgrade and new password restores normal access",
    async ({ page, state, calls, matching }) => {
      const legacyPassword = "legacy";
      const newPassword = "New strong upgrade passphrase 2026";
      state.identity = null;
      state.bootstrap = true;
      state.loginIdentity = { ...admin, password_change_required: true };
      state.passwordProofs.set(
        admin.email,
        fixtureProof(legacyPassword, saltFor(admin.email)),
      );
      await page.goto(`${base}/login`);
      await page.getByLabel("Email", { exact: true }).fill(admin.email);
      await page.getByLabel("Password", { exact: true }).fill(legacyPassword);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("heading", { name: "My Account", exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).pathname, "/account");
      await page
        .getByRole("alert", { name: "Password update required" })
        .getByText(
          "Update your password to finish the upgrade. Your existing transfers are safe; choose a new password before using your workspace.",
          { exact: true },
        )
        .waitFor();
      await page
        .locator("main")
        .getByText(`${admin.name} / ${admin.email} / Administrator`, {
          exact: true,
        })
        .waitFor();
      assert.equal(
        matching("/api/auth/login")[0].body.bootstrap_password,
        legacyPassword,
      );
      assert.equal(
        calls.filter((call) =>
          /^\/api\/(shares|requests|users|cost)(\/|$)/.test(call.path),
        ).length,
        0,
        "Flagged login never mounts a workspace screen",
      );
      for (const name of ["Dashboard", "Users", "Costs"])
        assert.equal(
          await page.getByRole("link", { name, exact: true }).count(),
          0,
        );
      assert.equal(
        await page.getByRole("button", { name: "Search", exact: true }).count(),
        0,
      );
      await page.getByRole("link", { name: "Account", exact: true }).waitFor();
      await page.getByRole("button", { name: "Logout", exact: true }).waitFor();
      const denied = await page.evaluate(
        async ({ actorId, targetId }) => {
          const { createWorkspaceClient, users, cost } =
            await import("/src/lib/api.ts");
          return Promise.all(
            [
              createWorkspaceClient().shares.list(),
              createWorkspaceClient(actorId, true).shares.init({ files: [] }),
              createWorkspaceClient(targetId, true).shares.init({ files: [] }),
              users.list(),
              cost.estimate(),
            ].map((operation) =>
              operation.then(
                () => 200,
                (error) => error.status,
              ),
            ),
          );
        },
        { actorId: admin.id, targetId: member.id },
      );
      assert.deepEqual(denied, [403, 403, 403, 403, 403]);
      assert.equal(state.initialized.length, 0);
      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
      assert.equal(
        await page.getByRole("dialog").count(),
        0,
        "Workspace headers cannot bypass forced upgrade or cause a reauth retry",
      );
      await page
        .getByLabel("Current password", { exact: true })
        .fill(legacyPassword);
      await page
        .getByLabel("New password", { exact: true })
        .fill("password123456!");
      await page
        .getByLabel("Confirm new password", { exact: true })
        .fill("password123456!");
      await page
        .getByRole("button", {
          name: "Change password and sign out",
          exact: true,
        })
        .click();
      await page
        .getByText("Choose a less common password", { exact: true })
        .waitFor();
      assert.equal(matching("/api/auth/password").length, 0);
      await page
        .getByRole("alert", { name: "Password update required" })
        .waitFor();
      await page.getByLabel("New password", { exact: true }).fill(newPassword);
      await page
        .getByLabel("Confirm new password", { exact: true })
        .fill(newPassword);
      await page
        .getByRole("button", {
          name: "Change password and sign out",
          exact: true,
        })
        .click();
      await page
        .getByRole("heading", { name: "Welcome back", exact: true })
        .waitFor();
      assert.equal(state.identity, null);
      assert.deepEqual(matching("/api/auth/password")[0].body, {
        current_proof: fixtureProof(legacyPassword, saltFor(admin.email)),
        new_proof: fixtureProof(newPassword, saltFor(admin.email)),
      });
      await page.getByLabel("Email", { exact: true }).fill(admin.email);
      await page.getByLabel("Password", { exact: true }).fill(newPassword);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      assert.equal(state.identity.password_change_required, false);
      assert.equal(
        await page
          .getByRole("alert", { name: "Password update required" })
          .count(),
        0,
      );
      assert.equal(
        matching("/api/auth/login")[1].body.bootstrap_password,
        undefined,
      );
      for (const name of ["Dashboard", "Users", "Costs", "Account"])
        await page.getByRole("link", { name, exact: true }).waitFor();
      await page.getByRole("button", { name: "Search", exact: true }).waitFor();
    },
  );

  await scenario(
    "forced sessions block protected deep links but preserve setup and mobile Account/logout",
    async ({ page, state, calls, matching }) => {
      for (const flag of [true, 1]) {
        state.identity = { ...admin, password_change_required: flag };
        for (const path of [
          "/dashboard",
          "/users",
          "/cost",
          "/upload",
          "/requests/new",
          "/shares/private-id",
          "/login",
        ]) {
          await page.goto(`${base}${path}`);
          await page
            .getByRole("heading", { name: "My Account", exact: true })
            .waitFor();
          await page
            .getByRole("alert", { name: "Password update required" })
            .waitFor();
          assert.equal(new URL(page.url()).pathname, "/account");
        }
      }
      assert.equal(
        calls.filter((call) =>
          /^\/api\/(shares|requests|users|cost)(\/|$)/.test(call.path),
        ).length,
        0,
      );
      await page.goto(`${base}/set-password#token=setup-token`);
      await page
        .getByRole("heading", { name: "Set your password", exact: true })
        .waitFor();
      await page.waitForFunction(() => location.hash === "");
      assert.equal(new URL(page.url()).pathname, "/set-password");
      assert.equal(
        await page
          .getByRole("alert", { name: "Password update required" })
          .count(),
        0,
      );
      assert.equal(
        await page.getByLabel("Current password", { exact: true }).count(),
        0,
      );
      await page.goto(`${base}/account`);
      await page
        .getByRole("heading", { name: "My Account", exact: true })
        .waitFor();
      await page.setViewportSize({ width: 390, height: 950 });
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await page.getByRole("link", { name: "Account", exact: true }).waitFor();
      for (const name of ["Dashboard", "Users", "Costs"])
        assert.equal(
          await page.getByRole("link", { name, exact: true }).count(),
          0,
        );
      assert.equal(
        await page.getByRole("button", { name: "Search", exact: true }).count(),
        0,
      );
      assert.equal(
        await page.locator("header a").first().getAttribute("href"),
        "/account",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      if (process.env.UI_SCREENSHOT_DIR) {
        await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: resolve(
            process.env.UI_SCREENSHOT_DIR,
            "password-upgrade-mobile.png",
          ),
          fullPage: true,
          animations: "disabled",
        });
      }
      await page.getByRole("button", { name: "Logout", exact: true }).click();
      await page
        .getByRole("heading", { name: "Welcome back", exact: true })
        .waitFor();
      assert.equal(state.identity, null);
      assert.equal(matching("/api/auth/logout").length, 1);
    },
  );

  for (const status of ["failed", "unknown", "queued"]) {
    await scenario(
      `null recovery link fails closed for welcome/reset/invitation with ${status} mail`,
      async ({ page, state, matching }) => {
        state.recoveryOverride = { value: null };
        state.createMail = state.resetMail = state.invitationMail = { status };
        await page.goto(`${base}/users`);
        await page.evaluate(() => {
          window.clipboardWrites = [];
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (value) => {
                window.clipboardWrites.push(value);
              },
            },
          });
        });
        await page
          .getByRole("button", { name: "Add user", exact: true })
          .click();
        await page.getByLabel("Name", { exact: true }).fill("New Member");
        await page.getByLabel("Email", { exact: true }).fill("new@example.com");
        await page
          .getByRole("button", { name: "Create user", exact: true })
          .click();
        await confirm(page);
        const panel = page.getByRole("region", {
          name: "Single-use password link",
        });
        async function assertUnavailable() {
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          await panel
            .getByText(
              "A recovery link is unavailable. Ask the administrator to correct the public origin before issuing another link.",
              { exact: true },
            )
            .waitFor();
          assert.equal(await panel.locator("input").count(), 0);
          assert.equal(
            await panel
              .getByRole("button", { name: "Copy link", exact: true })
              .count(),
            0,
          );
          assert.equal(await panel.locator("details").count(), 0);
          assert(
            !/share this|email queued|link issued|backup|fallback/i.test(
              await panel.innerText(),
            ),
          );
          assert.deepEqual(
            await page.evaluate(() => window.clipboardWrites),
            [],
          );
        }
        await assertUnavailable();
        await panel
          .getByRole("button", { name: "Dismiss notice", exact: true })
          .click();
        const row = page
          .getByRole("article")
          .filter({ hasText: "new@example.com" });
        await row
          .getByRole("button", { name: "Reset password", exact: true })
          .click();
        await confirm(page);
        await assertUnavailable();
        await panel
          .getByRole("button", { name: "Dismiss notice", exact: true })
          .click();
        state.preferences.set("new-user", {
          ...defaultEmailPreferences,
          invitation_reminders: true,
        });
        await row
          .getByRole("button", {
            name: "Send invitation reminder",
            exact: true,
          })
          .click();
        await confirm(page);
        await assertUnavailable();
        assert.equal(
          matching("/api/users").filter((call) => call.method === "POST")
            .length,
          1,
        );
        assert.equal(matching("/api/users/new-user/reset-password").length, 1);
        assert.equal(matching("/api/users/new-user/invitation").length, 1);
      },
    );
  }

  await scenario(
    "malformed recovery URLs never expose input or clipboard actions",
    async ({ page, state, matching }) => {
      await page.goto(`${base}/users`);
      await page.evaluate(() => {
        window.clipboardWrites = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value) => {
              window.clipboardWrites.push(value);
            },
          },
        });
      });
      const invalid = [
        "",
        undefined,
        false,
        { url: recoveryFixture },
        "javascript:alert(1)",
        recoveryFixture.replace("https:", "http:"),
        recoveryFixture.replace("/set-password", "/other"),
        "https://files.example.test/set-password#token=short",
        `https://files.example.test/set-password#token=${"g".repeat(64)}`,
        recoveryFixture.replace("#token=", "?token="),
        recoveryFixture.replace("#token=", "?other=1#token="),
        recoveryFixture.replace("https://", "https://someone:secret@"),
        `${recoveryFixture}&token=${"b".repeat(64)}`,
        ` ${recoveryFixture}`,
        recoveryFixture.replace("/set-password", "\\set-password"),
      ];
      for (const value of invalid) {
        state.recoveryOverride = { value };
        await page
          .getByRole("article")
          .filter({ hasText: member.email })
          .getByRole("button", { name: "Reset password", exact: true })
          .click();
        await confirm(page);
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        const panel = page.getByRole("region", {
          name: "Single-use password link",
        });
        await panel
          .getByText(
            "A recovery link is unavailable. Ask the administrator to correct the public origin before issuing another link.",
            { exact: true },
          )
          .waitFor();
        assert.equal(await panel.locator("input").count(), 0);
        assert.equal(
          await panel
            .getByRole("button", { name: "Copy link", exact: true })
            .count(),
          0,
        );
        await panel
          .getByRole("button", { name: "Dismiss notice", exact: true })
          .click();
      }
      assert.deepEqual(await page.evaluate(() => window.clipboardWrites), []);
      assert.equal(
        matching(`/api/users/${member.id}/reset-password`).length,
        invalid.length,
      );
    },
  );

  await scenario(
    "public-origin preflight 503 preserves create draft, accounts, and the current reset session",
    async ({ page, state, matching }) => {
      const originalAccounts = structuredClone(state.accounts);
      await page.goto(`${base}/users`);
      await page
        .getByRole("article")
        .filter({ hasText: admin.email })
        .waitFor();
      state.deny.set("/api/users", {
        remaining: 1,
        status: 503,
        detail:
          "Public origin must be configured before issuing a recovery link",
      });
      await page.getByRole("button", { name: "Add user", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Unsaved Member");
      await page
        .getByLabel("Email", { exact: true })
        .fill("unsaved@example.com");
      await page
        .getByRole("button", { name: "Create user", exact: true })
        .click();
      await confirm(page);
      await page
        .getByRole("dialog")
        .getByRole("alert")
        .filter({ hasText: "Public origin must be configured" })
        .waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal(
        await page.getByLabel("Name", { exact: true }).inputValue(),
        "Unsaved Member",
      );
      assert.deepEqual(state.accounts, originalAccounts);
      assert.equal(
        await page
          .getByRole("region", { name: "Single-use password link" })
          .count(),
        0,
      );
      state.deny.set(`/api/users/${admin.id}/reset-password`, {
        remaining: 1,
        status: 503,
        detail:
          "Public origin must be configured before issuing a recovery link",
      });
      await page
        .getByRole("article")
        .filter({ hasText: admin.email })
        .getByRole("button", { name: "Reset password", exact: true })
        .click();
      await confirm(page);
      await page
        .getByRole("dialog")
        .getByRole("alert")
        .filter({ hasText: "Public origin must be configured" })
        .waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal(state.identity.id, admin.id);
      assert.deepEqual(state.accounts, originalAccounts);
      assert.equal(
        await page
          .getByRole("region", { name: "Single-use password link" })
          .count(),
        0,
      );
      assert.equal(
        await page.getByLabel("Email", { exact: true }).inputValue(),
        "unsaved@example.com",
      );
      assert.equal(matching(`/api/users/${admin.id}/reset-password`).length, 1);
      await page.getByRole("heading", { name: "Users", exact: true }).waitFor();
    },
  );

  await scenario(
    "three new optional email preferences start off and save only changed keys",
    async ({ page, state, matching }) => {
      state.identity = member;
      await page.goto(`${base}/account`);
      const panel = page.getByRole("region", {
        name: "Email preferences",
        exact: true,
      });
      const labels = [
        "Password changed",
        "Transfers expiring soon",
        "Invitation reminders",
      ];
      for (const label of labels) {
        await panel
          .getByRole("checkbox", { name: label, exact: true })
          .waitFor();
        assert.equal(
          await panel
            .getByRole("checkbox", { name: label, exact: true })
            .isChecked(),
          false,
        );
      }
      assert.equal(await panel.getByRole("checkbox").count(), 5);
      assert.equal(
        await panel.getByText("Always on", { exact: true }).count(),
        2,
      );
      assert.equal(
        await panel
          .getByRole("checkbox", {
            name: /verification|welcome|password reset/i,
          })
          .count(),
        0,
      );
      await panel
        .getByText(/expire within 24 hours. These are not cost notifications/)
        .waitFor();
      await panel
        .getByText(/administrator to remind a pending account to finish setup/)
        .waitFor();
      for (const label of labels)
        await panel.getByRole("checkbox", { name: label, exact: true }).check();
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await panel
        .getByText("Email preferences saved.", { exact: true })
        .waitFor();
      assert.deepEqual(
        matching("/api/auth/email-preferences").findLast(
          (call) => call.method === "PATCH",
        ).body,
        {
          password_changed: true,
          expiry_alerts: true,
          invitation_reminders: true,
        },
      );
      await panel
        .getByRole("checkbox", { name: "Password changed", exact: true })
        .uncheck();
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await panel
        .getByText("Email preferences saved.", { exact: true })
        .waitFor();
      assert.deepEqual(
        matching("/api/auth/email-preferences").findLast(
          (call) => call.method === "PATCH",
        ).body,
        { password_changed: false },
      );
      assert.deepEqual(state.preferences.get(member.id), {
        ...defaultEmailPreferences,
        expiry_alerts: true,
        invitation_reminders: true,
      });
      assert.equal(matching("/api/auth/reauth").length, 0);
    },
  );

  await scenario(
    "pending invitation requires explicit opt-in and reauth; one reminder never repeats welcome",
    async ({ page, state, matching }) => {
      state.accounts.find((row) => row.id === member.id).status = "pending";
      state.accounts.push({
        ...member,
        id: "disabled-user",
        email: "disabled@example.com",
        status: "disabled",
      });
      await page.goto(`${base}/users`);
      const row = page.getByRole("article").filter({ hasText: member.email });
      await row
        .getByRole("button", { name: "Send invitation reminder", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", {
            name: "Send invitation reminder",
            exact: true,
          })
          .count(),
        1,
        "Active and disabled accounts have no reminder action",
      );
      await row
        .getByRole("button", { name: "Email preferences", exact: true })
        .click();
      const preferences = page.getByRole("region", {
        name: "Email preferences",
        exact: true,
      });
      await preferences
        .getByRole("checkbox", { name: "Password changed", exact: true })
        .check();
      await row
        .getByRole("button", { name: "Send invitation reminder", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByText(/replaces the previous setup link.*24 hours/)
        .waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal(matching(`/api/users/${member.id}/invitation`).length, 0);
      await row
        .getByRole("button", { name: "Send invitation reminder", exact: true })
        .click();
      await confirm(page);
      await page
        .getByRole("dialog")
        .getByRole("alert")
        .filter({
          hasText: "Enable invitation reminders in Email preferences first",
        })
        .waitFor();
      assert.equal(
        state.preferences.get(member.id).invitation_reminders,
        false,
      );
      assert.equal(state.invitationsIssued, 0);
      assert.equal(
        matching(`/api/users/${member.id}/email-preferences`).filter(
          (call) => call.method === "PATCH",
        ).length,
        0,
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal(
        await preferences
          .getByRole("checkbox", { name: "Password changed", exact: true })
          .isChecked(),
        true,
      );
      await preferences
        .getByRole("checkbox", { name: "Invitation reminders", exact: true })
        .check();
      await preferences
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await confirm(page);
      await preferences
        .getByText("Email preferences saved.", { exact: true })
        .waitFor();
      assert.deepEqual(
        matching(`/api/users/${member.id}/email-preferences`).findLast(
          (call) => call.method === "PATCH",
        ).body,
        { password_changed: true, invitation_reminders: true },
      );
      await row
        .getByRole("button", { name: "Send invitation reminder", exact: true })
        .click();
      await confirm(page);
      const panel = page.getByRole("region", {
        name: "Single-use password link",
      });
      await panel
        .getByRole("heading", {
          name: `Invitation reminder email queued for ${member.email}`,
          exact: true,
        })
        .waitFor();
      await panel.getByText(/This does not confirm delivery/).waitFor();
      await panel.getByText(/expires in 24 hours/).waitFor();
      assert.equal(
        await panel.getByLabel("Single-use link", { exact: true }).isVisible(),
        false,
      );
      await panel.getByText("Backup invitation link", { exact: true }).click();
      assert.equal(
        await panel.getByLabel("Single-use link", { exact: true }).inputValue(),
        invitationFixture(1),
      );
      assert.equal(state.invitationsIssued, 1);
      assert.equal(
        matching(`/api/users/${member.id}/invitation`).length,
        2,
        "Only the explicit off-state failure and explicit send occurred",
      );
      assert.equal(matching("/api/auth/reauth").length, 3);
      assert.equal(
        matching("/api/users").filter((call) => call.method === "POST").length,
        0,
        "No new welcome email or account recreation",
      );
      assert.equal(
        matching(`/api/users/${member.id}/reset-password`).length,
        0,
      );
      assert.equal(
        await page
          .getByRole("heading", { name: /Welcome email queued/ })
          .count(),
        0,
      );
      assert.equal(state.preferences.get(member.id).welcome, true);
      const request = matching(`/api/users/${member.id}/invitation`).at(-1);
      assert.equal(request.headers["x-expected-user"], admin.id);
      assert.equal(request.headers["x-workspace-user"], undefined);
    },
  );

  for (const status of ["unknown", "failed", "not_configured"]) {
    await scenario(
      `invitation mail ${status} retains the same fallback without automatic reissue`,
      async ({ page, state, matching }) => {
        state.accounts.find((row) => row.id === member.id).status = "pending";
        state.preferences.set(member.id, {
          ...defaultEmailPreferences,
          invitation_reminders: true,
        });
        state.invitationMail = { status };
        await page.goto(`${base}/users`);
        await page
          .getByRole("article")
          .filter({ hasText: member.email })
          .getByRole("button", {
            name: "Send invitation reminder",
            exact: true,
          })
          .click();
        await confirm(page);
        const panel = page.getByRole("region", {
          name: "Single-use password link",
        });
        await panel
          .getByRole("heading", {
            name: `Invitation link issued for ${member.email}`,
            exact: true,
          })
          .waitFor();
        await panel.getByLabel("Single-use link", { exact: true }).waitFor();
        if (status === "unknown")
          await panel
            .getByText(
              /It may already be queued. Do not generate a new link merely to resend/,
            )
            .waitFor();
        if (status === "failed")
          await panel
            .getByText(/Email was not queued. An invitation link was issued/)
            .waitFor();
        if (status === "not_configured")
          await panel.getByText(/Email is not configured/).waitFor();
        assert.equal(
          await panel
            .getByLabel("Single-use link", { exact: true })
            .inputValue(),
          invitationFixture(1),
        );
        await panel.getByLabel("Single-use link", { exact: true }).focus();
        assert.equal(state.invitationsIssued, 1);
        assert.equal(matching(`/api/users/${member.id}/invitation`).length, 1);
        assert.equal(
          matching("/api/users").filter((call) => call.method === "POST")
            .length,
          0,
        );
      },
    );
  }

  await scenario(
    "a stale pending-account invitation action rejects disabled targets without losing preference edits",
    async ({ page, state, matching }) => {
      state.accounts.find((row) => row.id === member.id).status = "pending";
      state.preferences.set(member.id, {
        ...defaultEmailPreferences,
        invitation_reminders: true,
      });
      await page.goto(`${base}/users`);
      const row = page.getByRole("article").filter({ hasText: member.email });
      await row
        .getByRole("button", { name: "Email preferences", exact: true })
        .click();
      const panel = page.getByRole("region", {
        name: "Email preferences",
        exact: true,
      });
      await panel
        .getByRole("checkbox", { name: "Transfers expiring soon", exact: true })
        .check();
      state.accounts.find((row) => row.id === member.id).status = "disabled";
      await row
        .getByRole("button", { name: "Send invitation reminder", exact: true })
        .click();
      await confirm(page);
      await page
        .getByRole("dialog")
        .getByRole("alert")
        .filter({
          hasText:
            "Invitation reminders are only available for pending accounts",
        })
        .waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal(
        await panel
          .getByRole("checkbox", {
            name: "Transfers expiring soon",
            exact: true,
          })
          .isChecked(),
        true,
      );
      assert.equal(state.preferences.get(member.id).expiry_alerts, false);
      assert.equal(state.invitationsIssued, 0);
      assert.equal(
        matching(`/api/users/${member.id}/email-preferences`).filter(
          (call) => call.method === "PATCH",
        ).length,
        0,
      );
      assert.equal(
        await page
          .getByRole("region", { name: "Single-use password link" })
          .count(),
        0,
      );
      await page.reload();
      await row.waitFor();
      assert.equal(
        await row
          .getByRole("button", {
            name: "Send invitation reminder",
            exact: true,
          })
          .count(),
        0,
      );
    },
  );

  await scenario(
    "own preferences load before editing and stay on the actual actor while viewing another workspace",
    async ({ page, state, matching }) => {
      await page.goto(`${base}/users`);
      await page
        .getByRole("article")
        .filter({ hasText: member.email })
        .getByRole("button", { name: "View workspace" })
        .click();
      await page.getByRole("button", { name: "Enable management" }).waitFor();
      const hold = deferred();
      state.responseHold.set("/api/auth/email-preferences", hold);
      await page.getByRole("link", { name: "Account", exact: true }).click();
      const panel = page.getByRole("region", {
        name: "Email preferences",
        exact: true,
      });
      await panel
        .getByText("Loading email preferences...", { exact: true })
        .waitFor();
      assert.equal(await panel.getByRole("checkbox").count(), 0);
      assert.equal(
        await panel
          .getByRole("button", { name: "Save email preferences", exact: true })
          .isDisabled(),
        true,
      );
      hold.resolve();
      await panel
        .getByRole("checkbox", { name: "Files downloaded", exact: true })
        .waitFor();
      assert.equal(await panel.getByRole("checkbox").count(), 5);
      assert.equal(
        await panel.getByText("Always on", { exact: true }).count(),
        2,
      );
      assert.equal(
        await panel
          .getByRole("checkbox", { name: "Files downloaded", exact: true })
          .isChecked(),
        false,
      );
      assert.equal(
        await panel
          .getByRole("checkbox", {
            name: "Files received via requests",
            exact: true,
          })
          .isChecked(),
        false,
      );
      await panel.getByText(/All emails are plain text/).waitFor();
      await panel
        .getByRole("checkbox", { name: "Files downloaded", exact: true })
        .check();
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await panel
        .getByText("Email preferences saved.", { exact: true })
        .waitFor();
      assert.deepEqual(
        matching("/api/auth/email-preferences").findLast(
          (call) => call.method === "PATCH",
        ).body,
        { share_downloads: true },
      );
      await panel
        .getByRole("checkbox", { name: "Files downloaded", exact: true })
        .uncheck();
      await panel
        .getByRole("checkbox", {
          name: "Files received via requests",
          exact: true,
        })
        .check();
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await panel
        .getByText("Email preferences saved.", { exact: true })
        .waitFor();
      assert.deepEqual(
        matching("/api/auth/email-preferences").findLast(
          (call) => call.method === "PATCH",
        ).body,
        { share_downloads: false, request_uploads: true },
      );
      assert.equal(matching("/api/auth/reauth").length, 0);
      assert.equal(state.preferences.has(member.id), false);
      assert.equal(state.preferences.get(admin.id).welcome, true);
      assert.equal(state.preferences.get(admin.id).password_reset, true);
      for (const call of matching("/api/auth/email-preferences")) {
        assert.equal(call.headers["x-expected-user"], admin.id);
        assert.equal(call.headers["x-workspace-user"], undefined);
        assert.equal(call.headers["x-workspace-mode"], undefined);
      }
      await page.setViewportSize({ width: 390, height: 950 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      if (process.env.UI_SCREENSHOT_DIR) {
        await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
        await panel.screenshot({
          path: resolve(
            process.env.UI_SCREENSHOT_DIR,
            "email-preferences-mobile.png",
          ),
          animations: "disabled",
        });
      }
    },
  );

  await scenario(
    "admin preferences fetch only the selected target, require reauth, and preserve edits on cancel/failure",
    async ({ page, state, calls, matching }) => {
      state.accounts.find((row) => row.id === member.id).status = "disabled";
      await page.goto(`${base}/users`);
      await page
        .getByRole("article")
        .filter({ hasText: member.email })
        .waitFor();
      assert.equal(
        calls.filter((call) => call.path.endsWith("/email-preferences")).length,
        0,
      );
      await page
        .getByRole("article")
        .filter({ hasText: member.email })
        .getByRole("button", { name: "Email preferences", exact: true })
        .click();
      const panel = page.getByRole("region", {
        name: "Email preferences",
        exact: true,
      });
      const path = `/api/users/${member.id}/email-preferences`;
      await panel
        .getByRole("checkbox", { name: "Files downloaded", exact: true })
        .waitFor();
      await panel
        .getByText(/delivery is blocked while this account is disabled/)
        .waitFor();
      await panel
        .getByRole("checkbox", { name: "Files downloaded", exact: true })
        .check();
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await page.getByRole("dialog").waitFor();
      assert.equal(
        matching(path).filter((call) => call.method === "PATCH").length,
        0,
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal(
        await panel
          .getByRole("checkbox", { name: "Files downloaded", exact: true })
          .isChecked(),
        true,
      );
      assert.equal(matching("/api/auth/reauth").length, 0);
      await panel
        .getByRole("checkbox", {
          name: "Files received via requests",
          exact: true,
        })
        .check();
      state.deny.set(path, {
        remaining: 1,
        status: 403,
        marked: false,
        detail: "Preferences could not be saved",
      });
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await confirm(page);
      await page
        .getByRole("dialog")
        .getByRole("alert")
        .filter({ hasText: "Preferences could not be saved" })
        .waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal(
        await panel
          .getByRole("checkbox", { name: "Files downloaded", exact: true })
          .isChecked(),
        true,
      );
      assert.equal(
        await panel
          .getByRole("checkbox", {
            name: "Files received via requests",
            exact: true,
          })
          .isChecked(),
        true,
      );
      assert.equal(state.preferences.get(member.id).share_downloads, false);
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await confirm(page);
      await panel
        .getByText("Email preferences saved.", { exact: true })
        .waitFor();
      const patches = matching(path).filter((call) => call.method === "PATCH");
      assert.equal(patches.length, 2);
      assert.deepEqual(patches[0].body, {
        share_downloads: true,
        request_uploads: true,
      });
      assert.deepEqual(patches[1].body, patches[0].body);
      assert(
        calls.indexOf(matching("/api/auth/reauth")[0]) <
          calls.indexOf(patches[0]),
      );
      assert.equal(matching("/api/auth/reauth").length, 2);
      assert.equal(matching("/api/auth/email-preferences").length, 0);
      assert(
        patches.every(
          (call) =>
            call.headers["x-expected-user"] === admin.id &&
            !call.headers["x-workspace-user"],
        ),
      );
      await panel
        .getByRole("button", { name: "Close preferences", exact: true })
        .click();
      await page
        .getByRole("article")
        .filter({ hasText: admin.email })
        .getByRole("button", { name: "Email preferences", exact: true })
        .click();
      await panel
        .getByRole("checkbox", { name: "Files downloaded", exact: true })
        .waitFor();
      assert.equal(
        await panel
          .getByRole("checkbox", { name: "Files downloaded", exact: true })
          .isChecked(),
        false,
      );
    },
  );

  await scenario(
    "preference load failure never supplies guessed defaults and own save failure preserves draft",
    async ({ page, state, matching }) => {
      const path = "/api/auth/email-preferences";
      state.deny.set(path, {
        remaining: Infinity,
        status: 500,
        detail: "Preferences unavailable",
      });
      await page.goto(`${base}/account`);
      const panel = page.getByRole("region", {
        name: "Email preferences",
        exact: true,
      });
      await panel
        .getByRole("alert")
        .filter({ hasText: "Preferences unavailable" })
        .waitFor();
      assert.equal(await panel.getByRole("checkbox").count(), 0);
      assert.equal(
        await panel
          .getByRole("button", { name: "Save email preferences", exact: true })
          .isDisabled(),
        true,
      );
      state.deny.delete(path);
      state.preferences.set(admin.id, {
        ...defaultEmailPreferences,
        share_downloads: true,
        request_uploads: false,
        welcome: true,
        password_reset: true,
      });
      await panel
        .getByRole("button", { name: "Retry loading preferences", exact: true })
        .click();
      await panel
        .getByRole("checkbox", { name: "Files downloaded", exact: true })
        .waitFor();
      assert.equal(
        await panel
          .getByRole("checkbox", { name: "Files downloaded", exact: true })
          .isChecked(),
        true,
      );
      await panel
        .getByRole("checkbox", { name: "Files downloaded", exact: true })
        .uncheck();
      state.deny.set(path, {
        remaining: 1,
        status: 500,
        detail: "Save failed",
      });
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await panel
        .getByRole("alert")
        .filter({ hasText: "Save failed" })
        .waitFor();
      assert.equal(
        await panel
          .getByRole("checkbox", { name: "Files downloaded", exact: true })
          .isChecked(),
        false,
      );
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await panel
        .getByText("Email preferences saved.", { exact: true })
        .waitFor();
      assert.deepEqual(
        matching(path)
          .filter((call) => call.method === "PATCH")
          .map((call) => call.body),
        [{ share_downloads: false }, { share_downloads: false }],
      );
      assert.equal(matching("/api/auth/reauth").length, 0);
      await page.evaluate(async () =>
        (await import("/src/lib/api.ts"))
          .createEmailPreferencesClient()
          .update({
            welcome: false,
            password_reset: false,
            share_downloads: true,
          }),
      );
      assert.deepEqual(
        matching(path).at(-1).body,
        { share_downloads: true },
        "Client whitelist never forwards mandatory fields",
      );
      assert.equal(state.preferences.get(admin.id).welcome, true);
      assert.equal(state.preferences.get(admin.id).password_reset, true);
    },
  );

  await scenario(
    "ordinary users save only their own preferences and cannot access admin preference routes",
    async ({ page, state, matching }) => {
      state.identity = member;
      await page.goto(`${base}/account`);
      const panel = page.getByRole("region", {
        name: "Email preferences",
        exact: true,
      });
      await panel
        .getByRole("checkbox", {
          name: "Files received via requests",
          exact: true,
        })
        .check();
      await panel
        .getByRole("button", { name: "Save email preferences", exact: true })
        .click();
      await panel
        .getByText("Email preferences saved.", { exact: true })
        .waitFor();
      assert.deepEqual(
        matching("/api/auth/email-preferences").findLast(
          (call) => call.method === "PATCH",
        ).body,
        { request_uploads: true },
      );
      assert.equal(matching("/api/auth/reauth").length, 0);
      const statuses = await page.evaluate(async (id) => {
        const { createEmailPreferencesClient, users } =
          await import("/src/lib/api.ts");
        const client = createEmailPreferencesClient(id);
        return Promise.all(
          [
            client.get(),
            client.update({ request_uploads: true }),
            users.invitation(id),
          ].map((operation) =>
            operation.then(
              () => 200,
              (error) => error.status,
            ),
          ),
        );
      }, admin.id);
      assert.deepEqual(statuses, [403, 403, 403]);
      assert.equal(state.preferences.has(admin.id), false);
      await page.goto(`${base}/users`);
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole("link", { name: "Users", exact: true }).count(),
        0,
      );
    },
  );

  for (const status of [
    "queued",
    "failed",
    "unknown",
    "not_configured",
    undefined,
  ]) {
    await scenario(
      `welcome/reset mail ${status || "missing metadata"} preserves one private fallback link`,
      async ({ page, state, matching }) => {
        state.createMail = state.resetMail = status
          ? {
              status,
              ...(status === "queued"
                ? { message_id: "accepted-message" }
                : { error_code: "mail-status-fixture" }),
            }
          : undefined;
        await page.goto(`${base}/users`);
        await page.evaluate(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text) => {
                window.copiedLink = text;
              },
            },
          });
        });
        await page
          .getByRole("button", { name: "Add user", exact: true })
          .click();
        await page.getByLabel("Name", { exact: true }).fill("New Member");
        await page.getByLabel("Email", { exact: true }).fill("new@example.com");
        await page
          .getByRole("button", { name: "Create user", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Create user and send welcome email" })
          .waitFor();
        await page
          .getByRole("dialog")
          .getByText(/welcome email explaining how iTransfer works/)
          .waitFor();
        await confirm(page);
        await page
          .getByRole("heading", {
            name:
              status === "queued"
                ? "Welcome email queued for new@example.com"
                : "User created for new@example.com",
            exact: true,
          })
          .waitFor();
        const panel = page.getByRole("region", {
          name: "Single-use password link",
        });
        assert.equal(
          await panel
            .getByLabel("Single-use link", { exact: true })
            .isVisible(),
          status !== "queued",
        );
        if (status === "queued")
          await panel.getByText(/This does not confirm delivery/).waitFor();
        else if (status === "failed")
          await panel
            .getByText(/Email was not queued.*The account was created/)
            .waitFor();
        else if (status === "not_configured")
          await panel
            .getByText(
              /Email is not configured.*Share this same link privately/,
            )
            .waitFor();
        else
          await panel
            .getByText(
              /It may already be queued. Do not generate a new link merely to resend/,
            )
            .waitFor();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        if (
          process.env.UI_SCREENSHOT_DIR &&
          ["queued", "unknown"].includes(status)
        ) {
          await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: resolve(process.env.UI_SCREENSHOT_DIR, `mail-${status}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
        if (status === "queued") {
          await panel.getByText("Backup setup link", { exact: true }).focus();
          await page.keyboard.press("Enter");
        }
        await panel
          .getByRole("button", { name: "Copy link", exact: true })
          .click();
        await panel
          .getByText("Link copied. Share it privately.", { exact: true })
          .waitFor();
        assert.equal(
          await page.evaluate(() => window.copiedLink),
          recoveryFixture,
        );
        assert.equal(
          matching("/api/users").filter((call) => call.method === "POST")
            .length,
          1,
        );
        assert.equal(
          matching("/api/auth/reauth").length,
          1,
          "No automatic retry or re-creation on mail failure",
        );
        await panel.getByRole("button", { name: "Dismiss link" }).click();
        await page
          .getByRole("article")
          .filter({ hasText: "new@example.com" })
          .getByRole("button", { name: "Reset password", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Send password reset email" })
          .waitFor();
        await confirm(page);
        await panel
          .getByRole("heading", {
            name:
              status === "queued"
                ? "Password reset email queued for new@example.com"
                : "Password reset link issued for new@example.com",
            exact: true,
          })
          .waitFor();
        assert.equal(
          await panel
            .getByLabel("Single-use link", { exact: true })
            .isVisible(),
          status !== "queued",
        );
        if (status === "queued")
          await panel
            .getByText("Backup password reset link", { exact: true })
            .click();
        if (status === "failed")
          await panel
            .getByText(/Email was not queued.*The reset link was issued/)
            .waitFor();
        await panel
          .getByRole("button", { name: "Copy link", exact: true })
          .click();
        assert.equal(
          await page.evaluate(() => window.copiedLink),
          recoveryFixture,
        );
        assert.equal(
          matching("/api/users/new-user/reset-password").length,
          1,
          "Copying the existing fallback must not issue a new token",
        );
        assert.equal(matching("/api/auth/reauth").length, 2);
      },
      status === "unknown" ? 390 : 1400,
    );
  }

  await scenario(
    "self reset retains the response and backup link after the server revokes the current session",
    async ({ page, state, calls, matching }) => {
      await page.goto(`${base}/users`);
      await page
        .getByRole("article")
        .filter({ hasText: admin.email })
        .getByRole("button", { name: "Reset password", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByText(/your current session will also be revoked/)
        .waitFor();
      await confirm(page);
      await page
        .getByRole("heading", {
          name: `Password reset email queued for ${admin.email}`,
        })
        .waitFor();
      assert.equal(
        state.identity,
        null,
        "Mock server revoked the current session",
      );
      const requestCount = calls.length;
      await page
        .getByText("Backup password reset link", { exact: true })
        .click();
      assert.equal(
        await page.getByLabel("Single-use link", { exact: true }).inputValue(),
        recoveryFixture,
      );
      assert.equal(
        calls.length,
        requestCount,
        "Opening the returned link is local, not an authenticated reload",
      );
      assert.equal(matching(`/api/users/${admin.id}/reset-password`).length, 1);
      assert.equal(new URL(page.url()).pathname, "/users");
    },
  );

  await scenario(
    "native PBKDF2 proof matches Node and temporary byte buffers are cleared",
    async ({ page }) => {
      await page.goto(`${base}/dashboard`);
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      const result = await page.evaluate(async (salt) => {
        const { derivePasswordProof } = await import("/src/lib/credentials.ts");
        const nativeImport = crypto.subtle.importKey.bind(crypto.subtle);
        const nativeDerive = crypto.subtle.deriveBits.bind(crypto.subtle);
        let inputBytes;
        let outputBytes;
        let algorithm;
        let extractable;
        crypto.subtle.importKey = async (...args) => {
          inputBytes = args[1];
          const key = await nativeImport(...args);
          extractable = key.extractable;
          return key;
        };
        crypto.subtle.deriveBits = async (...args) => {
          algorithm = args[0];
          const result = await nativeDerive(...args);
          outputBytes = new Uint8Array(result);
          return result;
        };
        try {
          const proof = await derivePasswordProof("native-proof-passphrase", {
            salt,
            iterations: 600000,
            bootstrap: false,
          });
          return {
            proof,
            inputCleared: inputBytes.every((byte) => byte === 0),
            outputCleared: outputBytes.every((byte) => byte === 0),
            iterations: algorithm.iterations,
            hash: algorithm.hash,
            extractable,
          };
        } finally {
          crypto.subtle.importKey = nativeImport;
          crypto.subtle.deriveBits = nativeDerive;
        }
      }, salts[member.email]);
      assert.equal(
        result.proof,
        fixtureProof("native-proof-passphrase", salts[member.email]),
      );
      assert.equal(result.iterations, 600000);
      assert.equal(result.hash, "SHA-256");
      assert.equal(result.extractable, false);
      assert(result.inputCleared && result.outputCleared);
    },
  );

  await scenario(
    "plaintext is sent only for an explicitly true bootstrap login challenge",
    async ({ page, state, matching }) => {
      state.identity = null;
      state.bootstrap = true;
      await page.goto(`${base}/login`);
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      await page.evaluate(async (email) => {
        const { auth } = await import("/src/lib/api.ts");
        await auth.login(email, "correct-password");
        await auth.login(email, "correct-password");
      }, member.email);
      const logins = matching("/api/auth/login");
      assert.equal(logins.length, 2);
      assert.deepEqual(Object.keys(logins[0].body).sort(), [
        "bootstrap_password",
        "email",
        "proof",
      ]);
      assert.equal(logins[0].body.bootstrap_password, "correct-password");
      assert.deepEqual(Object.keys(logins[1].body).sort(), ["email", "proof"]);
      assert.equal(logins[0].body.proof, correctProofs[salts[member.email]]);
      assert.equal(logins[1].body.proof, logins[0].body.proof);
      // An authenticated flow must never send plaintext, even for this flag.
      state.identity = admin;
      state.bootstrap = true;
      await page.goto(`${base}/dashboard`);
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      await page.evaluate(async () =>
        (await import("/src/lib/api.ts")).auth.reauth("correct-password"),
      );
      assert.deepEqual(Object.keys(matching("/api/auth/reauth")[0].body), [
        "proof",
      ]);
      const challenge = matching("/api/auth/password-challenge").at(-1);
      assert.deepEqual(
        challenge.body,
        { email: admin.email },
        "Reauth challenges the actual actor, not a viewed user",
      );
    },
  );

  await scenario(
    "invalid challenge parameters are rejected before native KDF work; unauthenticated challenge 401 does not expire a session",
    async ({ page, state, matching }) => {
      state.identity = null;
      await page.goto(`${base}/login`);
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      await page.evaluate(() => {
        window.kdfCalls = 0;
        window.expiredEvents = 0;
        const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
        crypto.subtle.deriveBits = (...args) => {
          window.kdfCalls++;
          return derive(...args);
        };
        window.addEventListener("session-expired", () => {
          window.expiredEvents++;
        });
      });
      const valid = {
        salt: salts[member.email],
        iterations: 600000,
        bootstrap: false,
      };
      for (const override of [
        { salt: "ab" },
        { salt: "g".repeat(32) },
        { iterations: 1 },
        { iterations: 600001 },
        { iterations: "600000" },
        { bootstrap: "true" },
        { bootstrap: 1 },
      ]) {
        state.challengeOverride = { ...valid, ...override };
        const message = await page.evaluate(async (email) => {
          try {
            await (
              await import("/src/lib/api.ts")
            ).auth.login(email, "correct-password");
            return "unexpected success";
          } catch (error) {
            return error.message;
          }
        }, member.email);
        assert.match(message, /Invalid password challenge/);
      }
      assert.equal(await page.evaluate(() => window.kdfCalls), 0);
      assert.equal(matching("/api/auth/login").length, 0);
      state.deny.set("/api/auth/password-challenge", {
        remaining: 1,
        status: 401,
        marked: false,
      });
      await page.evaluate(async () =>
        (await import("/src/lib/api.ts")).auth
          .setupPassword("setup-token", "new-password-1234")
          .catch(() => {}),
      );
      assert.equal(await page.evaluate(() => window.expiredEvents), 0);
      assert.equal(matching("/api/auth/setup-password").length, 0);
    },
  );

  await scenario(
    "new/reset password policy runs before requests but legacy login is not policy-gated",
    async ({ page, matching }) => {
      await page.goto(`${base}/dashboard`);
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      const results = await page.evaluate(async () => {
        const { auth } = await import("/src/lib/api.ts");
        const weak = [
          "short",
          "Riv3r!x",
          "x".repeat(129),
          "password123456!",
          "123456789012",
          "aaaaaaaaaaaa",
          "P@ssw0rd!!!!",
          "correcthorsebatterystaple",
        ];
        const results = [];
        for (const password of weak) {
          for (const operation of [
            () => auth.password("correct-password", password),
            () => auth.setupPassword("setup-token", password),
          ]) {
            try {
              await operation();
              results.push(false);
            } catch {
              results.push(true);
            }
          }
        }
        return results;
      });
      assert(results.every(Boolean));
      assert.equal(matching("/api/auth/password-challenge").length, 0);
      assert.equal(matching("/api/auth/password").length, 0);
      assert.equal(matching("/api/auth/setup-password").length, 0);
      await page.evaluate(
        async (email) =>
          (await import("/src/lib/api.ts")).auth
            .login(email, "short")
            .catch(() => {}),
        member.email,
      );
      assert.equal(
        matching("/api/auth/login").length,
        1,
        "Legacy password reaches server verification as a proof",
      );
    },
  );

  await scenario(
    "password setup and change accept eight characters and reject seven",
    async ({ page, matching }) => {
      await page.goto(`${base}/account`);
      await page.getByLabel("New password", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("New password", { exact: true }).getAttribute("minlength"), "8");
      assert.equal(await page.getByLabel("Confirm new password", { exact: true }).getAttribute("minlength"), "8");
      await page.getByText("Use 8 to 128 characters. A long, unique passphrase works well.").waitFor();
      const accepted = await page.evaluate(async () => {
        const { validateNewPassword } = await import("/src/lib/credentials.ts");
        return ["Riv3r!x", "Riv3r!xy"].map(password => {
          try { validateNewPassword(password); return true; } catch { return false; }
        });
      });
      assert.deepEqual(accepted, [false, true]);
      await page.evaluate(async () => {
        const { auth } = await import("/src/lib/api.ts");
        await auth.password("correct-password", "Riv3r!xy");
      });
      assert.equal(matching("/api/auth/password").length, 1);
      await page.goto(`${base}/set-password#token=setup-token`);
      await page.getByLabel("New password", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("New password", { exact: true }).getAttribute("minlength"), "8");
      await page.getByLabel("New password", { exact: true }).fill("Riv3r!x");
      await page.getByLabel("Confirm new password", { exact: true }).fill("Riv3r!x");
      assert.equal(await page.getByLabel("New password", { exact: true }).evaluate(input => input.validity.tooShort), true);
      await page.getByLabel("New password", { exact: true }).fill("Riv3r!xy");
      await page.getByLabel("Confirm new password", { exact: true }).fill("Riv3r!xy");
      await page.getByRole("button", { name: "Save password", exact: true }).click();
      await page.getByText("Your password is saved. Sign in to open your private workspace.").waitFor();
      assert.equal(matching("/api/auth/setup-password").length, 1);
    },
  );

  for (const ending of ["abort", "identity"]) {
    await scenario(
      `${ending} during native proof derivation discards output without POST`,
      async ({ page, matching }) => {
        await page.goto(`${base}/dashboard`);
        await page
          .getByRole("heading", { name: "Dashboard", exact: true })
          .waitFor();
        await page.evaluate(async () => {
          const { auth } = await import("/src/lib/api.ts");
          const nativeDerive = crypto.subtle.deriveBits.bind(crypto.subtle);
          const gate = new Promise((resolve) => {
            window.releaseProof = resolve;
          });
          crypto.subtle.deriveBits = async (...args) => {
            const bytes = await nativeDerive(...args);
            window.proofReady = true;
            await gate;
            return bytes;
          };
          window.proofAbort = new AbortController();
          window.proofResult = auth
            .reauth("correct-password", window.proofAbort.signal)
            .then(
              () => ({ status: "fulfilled" }),
              (error) => ({
                status: "rejected",
                name: error.name,
                code: error.code,
              }),
            );
        });
        await page.waitForFunction(() => window.proofReady === true);
        await page.evaluate((ending) => {
          if (ending === "abort") window.proofAbort.abort();
          else window.dispatchEvent(new Event("session-expired"));
          window.releaseProof();
        }, ending);
        const result = await page.evaluate(() => window.proofResult);
        assert.equal(result.status, "rejected");
        if (ending === "abort") assert.equal(result.name, "AbortError");
        else assert.equal(result.code, "IDENTITY_CHANGED");
        assert.equal(matching("/api/auth/reauth").length, 0);
      },
    );
  }

  await scenario(
    "missed cross-tab notification: stale own composer sends Alice actor/target and cannot upload as Bob",
    async ({ page, context, state, calls, matching }) => {
      // Exercise the server-header backstop even when BroadcastChannel is unavailable.
      await page.addInitScript(() => {
        window.BroadcastChannel = undefined;
      });
      await ownComposer(page);
      state.identity = null;
      const bob = await context.newPage();
      await signIn(bob);
      assert.equal(state.identity.id, member.id);
      await page
        .getByRole("button", { name: "Create Share", exact: true })
        .click();
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      const rejected = matching("/api/shares/init");
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].headers["x-expected-user"], admin.id);
      assert.equal(rejected[0].headers["x-workspace-user"], admin.id);
      assert.equal(
        rejected[0].headers["x-workspace-mode"],
        undefined,
        "Own workspace is not management mode",
      );
      assert.equal(
        state.initialized.length,
        0,
        "No share is created under Bob",
      );
      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
    },
  );

  await scenario(
    "login/logout broadcasts invalidate other tabs without identity or token payloads",
    async ({ page, context, state, calls }) => {
      await ownComposer(page);
      const bob = await context.newPage();
      await bob.addInitScript(() => {
        window.authMessages = [];
        const NativeChannel = window.BroadcastChannel;
        window.BroadcastChannel = class extends NativeChannel {
          postMessage(message) {
            if (this.name === "itransfer-auth")
              window.authMessages.push(message);
            return super.postMessage(message);
          }
        };
      });
      state.identity = null;
      await signIn(bob);
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      await page
        .getByText(
          "Your account changed in another tab. Refresh or sign in again.",
          { exact: true },
        )
        .waitFor();
      assert.equal(await page.getByPlaceholder("My awesome files").count(), 0);
      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
      assert.deepEqual(await bob.evaluate(() => window.authMessages), [
        { type: "login" },
      ]);
      // Refresh is an explicit acquisition of the shared browser's current identity.
      await page.reload();
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      await bob.getByRole("button", { name: "Logout", exact: true }).click();
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      assert.deepEqual(await bob.evaluate(() => window.authMessages), [
        { type: "login" },
        { type: "logout" },
      ]);
    },
  );

  await scenario(
    "old authorized upload-init response is discarded after another tab logs in",
    async ({ page, context, state, calls, matching }) => {
      await ownComposer(page);
      const hold = deferred();
      state.responseHold.set("/api/shares/init", hold);
      await page
        .getByRole("button", { name: "Create Share", exact: true })
        .click();
      await until(
        () => state.initialized.length === 1,
        "Alice's original request is authorized before the switch",
      );
      state.identity = null;
      const bob = await context.newPage();
      await signIn(bob);
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      const response = page.waitForResponse((response) =>
        response.url().endsWith("/api/shares/init"),
      );
      hold.resolve();
      await response;
      // Drain the response through the browser before asserting absence of PUTs.
      await page.evaluate(() => new Promise((done) => setTimeout(done, 100)));
      assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
      assert.equal(state.initialized[0].actor, admin.id);
      assert.equal(state.initialized[0].expected, admin.id);
      assert.equal(matching("/api/shares/init").length, 1);
      await bob
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
    },
  );

  await scenario(
    "stale private result and old workspace client cannot cross an identity epoch",
    async ({ page, state, matching }) => {
      await page.goto(`${base}/dashboard`);
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      const hold = deferred();
      state.responseHold.set("/api/cost/estimate", hold);
      await page.evaluate(async () => {
        const { cost, createWorkspaceClient } = await import("/src/lib/api.ts");
        window.oldClient = createWorkspaceClient();
        window.oldResult = cost.estimate().then(
          () => ({ status: "fulfilled" }),
          (error) => ({ status: "rejected", code: error.code }),
        );
      });
      await until(
        () => matching("/api/cost/estimate").length === 1,
        "Old cost request should start",
      );
      await page.getByRole("button", { name: "Logout", exact: true }).click();
      await signIn(page, false);
      hold.resolve();
      assert.deepEqual(await page.evaluate(() => window.oldResult), {
        status: "rejected",
        code: "IDENTITY_CHANGED",
      });
      const count = matching("/api/shares/init").length;
      const stale = await page.evaluate(() =>
        window.oldClient.shares.init({ files: [] }).then(
          () => "fulfilled",
          (error) => error.code,
        ),
      );
      assert.equal(stale, "IDENTITY_CHANGED");
      assert.equal(
        matching("/api/shares/init").length,
        count,
        "Old clients fail locally rather than adopting Bob",
      );
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      assert.equal(
        matching("/api/cost/estimate")[0].headers["x-expected-user"],
        admin.id,
      );
    },
  );

  await scenario(
    "late initial me cannot overwrite a cross-tab invalidation",
    async ({ page, context, state, matching }) => {
      const hold = deferred();
      state.responseHold.set("/api/auth/me", hold);
      await page.goto(`${base}/dashboard`);
      await until(
        () => matching("/api/auth/me").length > 0,
        "Initial identity response should be pending",
      );
      // Other tabs may acquire identity normally while Alice's old response waits.
      state.responseHold.delete("/api/auth/me");
      state.identity = null;
      const bob = await context.newPage();
      await signIn(bob);
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      hold.resolve();
      await page.evaluate(() => new Promise((done) => setTimeout(done, 100)));
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      assert.equal(
        await page.evaluate(
          async () =>
            (await import("/src/lib/api.ts")).getAuthIdentity().userId,
        ),
        null,
      );
    },
  );

  await scenario(
    "late login response cannot restore identity after logout notification",
    async ({ page, state, matching }) => {
      state.identity = null;
      await page.goto(`${base}/login`);
      const hold = deferred();
      state.responseHold.set("/api/auth/login", hold);
      await page.getByLabel("Email", { exact: true }).fill(member.email);
      await page
        .getByLabel("Password", { exact: true })
        .fill("correct-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await until(
        () => matching("/api/auth/login").length === 1,
        "Login should be in flight",
      );
      await page.evaluate(() => {
        const channel = new BroadcastChannel("itransfer-auth");
        channel.postMessage({ type: "logout" });
        channel.close();
      });
      await page
        .getByText(
          "Your account changed in another tab. Refresh or sign in again.",
          { exact: true },
        )
        .waitFor();
      hold.resolve();
      await page
        .getByRole("button", { name: "Sign in", exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(
          async () =>
            (await import("/src/lib/api.ts")).getAuthIdentity().userId,
        ),
        null,
      );
      assert.equal(matching("/api/shares").length, 0);
    },
  );

  for (const [width, device] of [
    [1400, "desktop"],
    [390, "mobile"],
  ]) {
    await scenario(
      `Users and administrator Costs acceptance (${device})`,
      async ({ page, state, matching }) => {
        await page.goto(`${base}/users`);
        await page
          .getByRole("article")
          .filter({ hasText: member.email })
          .waitFor();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        if (process.env.UI_SCREENSHOT_DIR) {
          await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: resolve(process.env.UI_SCREENSHOT_DIR, `users-${device}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
        await page.goto(`${base}/cost`);
        await page.getByRole("heading", { name: "Cost by User" }).waitFor();
        assert.equal(await page.getByRole("table").getByRole("row").count(), 3);
        await page
          .getByRole("table")
          .getByRole("row")
          .filter({ hasText: member.email })
          .getByText("4 GB", { exact: true })
          .waitFor();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        if (process.env.UI_SCREENSHOT_DIR) {
          await page.screenshot({
            path: resolve(process.env.UI_SCREENSHOT_DIR, `costs-${device}.png`),
            fullPage: true,
            animations: "disabled",
          });
          console.log(
            `Cost numeric cell color (${device}): ${await page
              .getByRole("table")
              .locator("td")
              .first()
              .evaluate((cell) => getComputedStyle(cell).color)}`,
          );
        }
        if (width < 600) {
          const scrollable = await page.getByRole("table").evaluate((table) => {
            const container = table.parentElement;
            container.scrollLeft = container.scrollWidth;
            return (
              container.scrollWidth <= container.clientWidth ||
              container.scrollLeft > 0
            );
          });
          assert(scrollable, "All cost columns are reachable on mobile");
        }
        await page.goto(`${base}/users`);
        await page
          .getByRole("article")
          .filter({ hasText: member.email })
          .getByRole("button", { name: "View workspace" })
          .click();
        await page.getByRole("button", { name: "Enable management" }).waitFor();
        if (width < 600)
          await page.getByRole("button", { name: "Open navigation" }).click();
        await page.getByRole("link", { name: "Costs", exact: true }).click();
        await page.getByRole("heading", { name: "Cost by User" }).waitFor();
        assert.equal(
          await page
            .getByText("Viewing Morgan Member's workspace", { exact: true })
            .count(),
          0,
        );
        assert(
          matching("/api/cost/estimate").every(
            (call) =>
              !call.headers["x-workspace-user"] &&
              !call.headers["x-workspace-mode"],
          ),
        );
        const costRequests = matching("/api/cost/estimate").length;
        const userRequests = matching("/api/users").length;
        state.identity = member;
        for (const path of ["cost", "users"]) {
          await page.goto(`${base}/${path}`);
          await page
            .getByRole("heading", { name: "Dashboard", exact: true })
            .waitFor();
          assert.equal(new URL(page.url()).pathname, "/dashboard");
        }
        if (width < 600)
          await page.getByRole("button", { name: "Open navigation" }).click();
        assert.equal(
          await page.getByRole("link", { name: "Costs", exact: true }).count(),
          0,
        );
        assert.equal(
          await page.getByRole("link", { name: "Users", exact: true }).count(),
          0,
        );
        assert.equal(
          matching("/api/cost/estimate").length,
          costRequests,
          "Ordinary user never requests Costs",
        );
        assert.equal(
          matching("/api/users").length,
          userRequests,
          "Ordinary user never requests Users",
        );
      },
      width,
    );
  }

  await scenario(
    "administrator create/edit/role/disable/enable/reset/revoke and account limit",
    async ({ page, matching }) => {
      await page.goto(`${base}/users`);
      await page.getByRole("button", { name: "Add user", exact: true }).click();
      const name = page.getByLabel("Name", { exact: true });
      assert.equal(await name.getAttribute("maxlength"), "100");
      await name.fill("New Member");
      await page.getByLabel("Email", { exact: true }).fill("new@example.com");
      await page
        .getByRole("button", { name: "Create user", exact: true })
        .click();
      await confirm(page);
      await page
        .getByText("Welcome email queued for new@example.com", { exact: true })
        .waitFor();
      assert.equal(
        matching("/api/users").findLast((call) => call.method === "POST").body
          .role,
        "user",
      );
      await page.getByRole("button", { name: "Dismiss link" }).click();
      const row = page
        .getByRole("article")
        .filter({ hasText: "new@example.com" });
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Updated Member");
      await page.getByRole("combobox").selectOption("admin");
      await page.getByRole("button", { name: "Review changes" }).click();
      await confirm(page);
      await page.getByText("User updated.", { exact: true }).waitFor();
      assert.equal(matching("/api/users/new-user").at(-1).body.role, "admin");
      await row.getByRole("button", { name: "Disable", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByText(/existing public share and request links remain active/)
        .waitFor();
      await confirm(page);
      await page.getByText("Account disabled.", { exact: true }).waitFor();
      assert.equal(
        await row
          .getByRole("button", { name: "Reset password", exact: true })
          .isDisabled(),
        true,
      );
      await row.getByRole("button", { name: "Enable", exact: true }).click();
      await confirm(page);
      await page.getByText("Account active.", { exact: true }).waitFor();
      await row
        .getByRole("button", { name: "Reset password", exact: true })
        .click();
      await confirm(page);
      await page
        .getByText("Password reset email queued for new@example.com", {
          exact: true,
        })
        .waitFor();
      await row
        .getByRole("button", { name: "Revoke sessions", exact: true })
        .click();
      await confirm(page);
      await page
        .getByText("All sessions revoked for new@example.com.", { exact: true })
        .waitFor();
      assert.equal(matching("/api/auth/reauth").length, 6);
      assert.equal(matching("/api/users/new-user/reset-password").length, 1);
      assert.equal(matching("/api/users/new-user/revoke-sessions").length, 1);
    },
  );

  await scenario(
    "manual setup, login, and account password change",
    async ({ page, state, matching }) => {
      state.identity = null;
      await page.goto(`${base}/set-password#token=expired-token`);
      await page.getByRole("heading", { name: "Set your password" }).waitFor();
      await page.waitForFunction(() => location.hash === "");
      assert.equal(new URL(page.url()).hash, "");
      await page
        .getByLabel("New password", { exact: true })
        .fill("new-password-1234");
      await page.getByLabel("Confirm new password", { exact: true }).fill("new-password-1234");
      await page
        .getByRole("button", { name: "Save password", exact: true })
        .click();
      await page
        .getByText("Invalid or expired setup link", { exact: true })
        .waitFor();
      // A manually supplied replacement link is opened as a fresh document.
      await page.goto(`${base}/login`);
      await page.getByRole("heading", { name: "Welcome back" }).waitFor();
      await page.goto(`${base}/set-password#token=setup-token`);
      await page.getByRole("heading", { name: "Set your password" }).waitFor();
      await page.waitForFunction(() => location.hash === "");
      assert.equal(new URL(page.url()).hash, "");
      assert.equal(
        await page.evaluate(() =>
          JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
            "setup-token",
          ),
        ),
        false,
      );
      await page
        .getByLabel("New password", { exact: true })
        .fill("new-password-1234");
      await page.getByLabel("Confirm new password", { exact: true }).fill("mismatched-password");
      await page
        .getByRole("button", { name: "Save password", exact: true })
        .click();
      await page
        .getByText("The passwords do not match. Please enter them again.", {
          exact: true,
        })
        .waitFor();
      await page.getByLabel("Confirm new password", { exact: true }).fill("new-password-1234");
      await page
        .getByRole("button", { name: "Save password", exact: true })
        .click();
      await page
        .getByText(
          "Your password is saved. Sign in to open your private workspace.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        matching("/api/auth/login").length,
        0,
        "Setup never auto logs in",
      );
      await page.getByRole("link", { name: "Go to sign in" }).click();
      await page.getByLabel("Email", { exact: true }).fill(member.email);
      await page.getByLabel("Password", { exact: true }).fill("wrong-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByText("Invalid credentials", { exact: true }).waitFor();
      await page
        .getByLabel("Password", { exact: true })
        .fill("correct-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("heading", { name: "Dashboard", exact: true })
        .waitFor();
      await page.getByRole("link", { name: "Account", exact: true }).click();
      await page.getByLabel("Current password", { exact: true }).fill("correct-password");
      await page
        .getByLabel("New password", { exact: true })
        .fill("new-password-1234");
      await page.getByLabel("Confirm new password", { exact: true }).fill("new-password-1234");
      await page
        .getByRole("button", { name: "Change password and sign out" })
        .click();
      await page
        .getByText(
          "Password changed. All sessions have been signed out. Sign in with your new password.",
          { exact: true },
        )
        .waitFor();
      assert.equal(new URL(page.url()).pathname, "/login");
      assert.equal(matching("/api/auth/password").length, 1);
      assert.deepEqual(matching("/api/auth/password")[0].body, {
        current_proof: correctProofs[salts[member.email]],
        new_proof: fixtureProof("new-password-1234", salts[member.email]),
      });
      assert.deepEqual(matching("/api/auth/setup-password").at(-1).body, {
        token: "setup-token",
        proof: fixtureProof("new-password-1234", salts[member.email]),
      });
    },
  );

  await scenario("Costs empty and error states", async ({ page, state }) => {
    state.cost.users = [];
    await page.goto(`${base}/cost`);
    await page
      .getByText("No user usage available yet.", { exact: true })
      .waitFor();
    state.deny.set("/api/cost/estimate", { remaining: Infinity, status: 500 });
    await page.reload();
    await page
      .getByText("Failed to load cost data.", { exact: true })
      .waitFor();
  });

  await scenario(
    "expired multipart completion resumes in place without another upload",
    async ({ page, state, calls, matching }) => {
      state.deny.set(completion, { remaining: 1 });
      await uploadManaged(page);
      await page
        .getByRole("heading", { name: "Continue workspace operation" })
        .waitFor();
      assert.equal(calls.filter((call) => call.method === "PUT").length, 3);
      await confirm(page, "wrong-password");
      await page.getByText("Invalid password", { exact: true }).waitFor();
      assert.equal(
        matching(completion).length,
        1,
        "Wrong password never retries completion",
      );
      await confirm(page);
      await page.getByRole("heading", { name: "Share created!" }).waitFor();
      assertUpload(calls, matching, 2, 1);
      assert.equal(
        matching("/api/auth/reauth").length,
        3,
        "Initial management, failed confirmation, renewed confirmation",
      );
    },
  );

  for (const blockedPath of [completion, confirmShare]) {
    await scenario(
      `cancel and retry ${blockedPath} preserves uploaded parts and completed files`,
      async ({ page, state, calls, matching }) => {
        state.deny.set(blockedPath, { remaining: 2 });
        await uploadManaged(page);
        await page
          .getByRole("heading", { name: "Continue workspace operation" })
          .waitFor();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "Password confirmation cancelled" })
          .waitFor();
        assert.equal(
          await page.getByPlaceholder("My awesome files").inputValue(),
          "Keep this upload",
        );
        await page
          .getByRole("button", { name: "Retry upload", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Continue workspace operation" })
          .waitFor();
        await confirm(page);
        await page.getByRole("heading", { name: "Share created!" }).waitFor();
        assertUpload(
          calls,
          matching,
          blockedPath === completion ? 3 : 1,
          blockedPath === completion ? 1 : 3,
        );
      },
      390,
    );
  }

  await scenario(
    "only marked 403 managed mutations retry, and at most once",
    async ({ page, state, matching }) => {
      await page.goto(`${base}/users`);
      await page.getByRole("heading", { name: "Users", exact: true }).waitFor();
      for (const path of [
        "/api/shares",
        "/api/shares/init",
        "/api/shares/read/download",
        "/api/users",
        "/api/cost/estimate",
        "/api/public/shares/public/download",
        "/api/auth/reauth",
      ])
        state.deny.set(path, { remaining: Infinity });
      state.deny.set("/api/shares/plain", {
        remaining: Infinity,
        marked: false,
      });
      state.deny.set("/api/shares/repeated", { remaining: Infinity });
      state.deny.set("/api/shares/error", { remaining: Infinity, status: 500 });
      const result = await page.evaluate(async () => {
        const { createWorkspaceClient, users, cost, publicApi, auth } =
          await import("/src/lib/api.ts");
        let confirmations = 0;
        const reauthorize = async () => {
          confirmations++;
        };
        const own = createWorkspaceClient(undefined, true, reauthorize);
        const readOnly = createWorkspaceClient("member-1", false, reauthorize);
        const managed = createWorkspaceClient("member-1", true, reauthorize);
        const checks = await Promise.allSettled([
          own.shares.init({ files: [] }),
          readOnly.shares.init({ files: [] }),
          managed.shares.list(),
          managed.shares.download("read"),
          managed.shares.extend("plain", 7),
          managed.shares.extend("error", 7),
          users.create({
            name: "Example",
            email: "example@example.com",
            role: "user",
          }),
          cost.estimate(),
          publicApi.download("public"),
          auth.reauth("correct-password"),
        ]);
        const excludedConfirmations = confirmations;
        await managed.shares.extend("repeated", 7).catch(() => {});
        return {
          checks: checks.map((check) => check.status),
          excludedConfirmations,
          confirmations,
        };
      });
      assert(result.checks.every((status) => status === "rejected"));
      assert.equal(result.excludedConfirmations, 0);
      assert.equal(result.confirmations, 1);
      assert.equal(
        matching("/api/shares/repeated").length,
        2,
        "No recursive retries",
      );
      assert.equal(
        matching("/api/shares/plain").length,
        1,
        "Body code alone must not enable retry",
      );
      assert.equal(
        matching("/api/shares/init").length,
        1,
        "Read-only mutation blocked locally",
      );
      assert.equal(await page.getByRole("dialog").count(), 0);
    },
  );

  await scenario(
    "provider coalesces confirmations and retains original scope across UI workspace changes",
    async ({ page, state, matching }) => {
      await harness(page);
      const paths = [
        "/api/shares/one/complete-multipart",
        "/api/shares/two/complete-multipart",
      ];
      for (const path of paths) state.deny.set(path, { remaining: 1 });
      await page.evaluate(() => {
        const client = window.uiTest.client;
        const body = {
          file_id: "original-file",
          upload_id: "original-upload",
          parts: [{ part_number: 1, etag: '"original-etag"' }],
        };
        window.operations = Promise.allSettled([
          client.shares.completeMultipart("one", body),
          client.shares.completeMultipart("two", body),
        ]);
        body.parts[0].etag = "changed-after-request";
      });
      await until(
        () => paths.every((path) => matching(path).length === 1),
        "Both operations should reach the gate",
      );
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      await page.evaluate(
        (target) =>
          window.uiTest.view(
            { ...target, id: "member-2", name: "Other Member" },
            true,
          ),
        member,
      );
      await page.waitForFunction(() => window.uiTest.target?.id === "member-2");
      await confirm(page);
      const results = await page.evaluate(() => window.operations);
      assert(results.every((result) => result.status === "fulfilled"));
      assert.equal(matching("/api/auth/reauth").length, 1);
      for (const path of paths) {
        assert.equal(matching(path).length, 2);
        assert.deepEqual(matching(path)[0].body, matching(path)[1].body);
        assert.equal(matching(path)[1].body.parts[0].etag, '"original-etag"');
        assert.equal(matching(path)[1].headers["x-workspace-user"], "member-1");
      }
      await page.evaluate(() => window.uiTest.unmount());
    },
  );

  for (const ending of [
    "logout",
    "unmount",
    "account-before",
    "account-during",
    "unmount-in-flight",
  ]) {
    await scenario(
      `${ending} rejects pending confirmation without retrying`,
      async ({ page, state, matching }) => {
        await harness(page);
        state.deny.set(completion, { remaining: 1 });
        await page.evaluate(() => {
          window.operations = Promise.allSettled([
            window.uiTest.client.shares.completeMultipart("upload-share", {
              file_id: "f",
              upload_id: "u",
              parts: [],
            }),
          ]);
        });
        await page
          .getByRole("heading", { name: "Continue workspace operation" })
          .waitFor();
        if (ending === "logout")
          await page.evaluate(() => window.uiTest.logout());
        else if (ending === "unmount")
          await page.evaluate(() => window.uiTest.unmount());
        else if (ending === "unmount-in-flight") {
          const hold = deferred();
          state.hold.set("/api/auth/reauth", hold);
          await confirm(page);
          await until(
            () => matching("/api/auth/reauth").length === 1,
            "Reauth should be in flight",
          );
          await page.evaluate(() => window.uiTest.unmount());
          hold.resolve();
        } else {
          if (ending === "account-before")
            state.identity = { ...admin, id: "other-admin" };
          else state.reauthIdentity = { ...admin, id: "other-admin" };
          await confirm(page);
        }
        const results = await page.evaluate(() => window.operations);
        assert(results.every((result) => result.status === "rejected"));
        assert.equal(matching(completion).length, 1);
        assert.equal(
          matching("/api/auth/reauth").length,
          ["account-during", "unmount-in-flight"].includes(ending) ? 1 : 0,
        );
        assert.equal(await page.getByRole("dialog").count(), 0);
      },
    );
  }

  await scenario(
    "a late marked 403 cannot prompt after the provider unmounts",
    async ({ page, state, matching }) => {
      await harness(page);
      const hold = deferred();
      state.hold.set(completion, hold);
      state.deny.set(completion, { remaining: 1 });
      await page.evaluate(() => {
        window.operations = Promise.allSettled([
          window.uiTest.client.shares.completeMultipart("upload-share", {
            file_id: "f",
            upload_id: "u",
            parts: [],
          }),
        ]);
      });
      await until(
        () => matching(completion).length === 1,
        "Completion should be in flight",
      );
      await page.evaluate(() => window.uiTest.unmount());
      hold.resolve();
      assert.equal(
        (await page.evaluate(() => window.operations))[0].status,
        "rejected",
      );
      assert.equal(matching(completion).length, 1);
      assert.equal(matching("/api/auth/reauth").length, 0);
      assert.equal(await page.getByRole("dialog").count(), 0);
    },
  );
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
}
