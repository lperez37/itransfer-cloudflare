/** iTransfer on Cloudflare Workers: Hono API + static frontend assets + cron
 * cleanup. File bytes move browser <-> R2 via presigned URLs and never pass
 * through the Worker. */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "./types";
import { assertEnv } from "./types";
import { requireSession } from "./lib/auth";
import { estimateCost } from "./lib/cost";
import { authRoutes } from "./routes/auth";
import { shareRoutes } from "./routes/shares";
import { requestRoutes } from "./routes/requests";
import { publicRoutes } from "./routes/public";
import { apiV1Routes } from "./routes/apiV1";
import { runCleanup } from "./scheduled";

const app = new Hono<AppEnv>();

// Errors use the same {"detail": "..."} envelope as the original FastAPI app.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    const headers = new Headers(res.headers);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ detail: err.message || "Error" }), {
      status: res.status,
      headers,
    });
  }
  console.error("Unhandled error:", err);
  return c.json({ detail: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ detail: "Not found" }, 404));

app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/ready", (c) => c.json({ status: "ready" }));

app.route("/api/auth", authRoutes);
app.route("/api/shares", shareRoutes);
app.route("/api/requests", requestRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/v1", apiV1Routes);

app.get("/api/cost/estimate", requireSession, async (c) => c.json(await estimateCost(c.env.DB)));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      assertEnv(env);
    } catch (err) {
      // Misconfiguration is a server condition, not a client one - fail fast
      // with a clear message rather than limping along in an unsafe state.
      console.error("Startup configuration error:", err);
      return new Response(
        JSON.stringify({ detail: err instanceof Error ? err.message : "Server misconfigured" }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }
    return app.fetch(request, env, ctx);
  },

  /** Hourly: reclaim storage for abandoned uploads and expired shares/requests. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    assertEnv(env);
    ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<Env>;
