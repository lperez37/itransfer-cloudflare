/** ID generation: URL-safe random tokens and human-friendly animal combos. */

import { HTTPException } from "hono/http-exception";
import { utcNow } from "./util";

/** Bounded retries when a freshly generated public id collides. */
const MAX_ID_ATTEMPTS = 8;

const ANIMALS: readonly string[] = [
  "ant", "bear", "bee", "bird", "bug",
  "bull", "cat", "cow", "crab", "crow",
  "deer", "dog", "duck", "fish", "fly",
  "fox", "frog", "goat", "hen", "horse",
  "lamb", "lion", "monkey", "mouse", "panda",
  "pig", "pony", "rabbit", "rat", "seal",
  "shark", "sheep", "snake", "spider", "tiger",
  "tuna", "turtle", "whale", "wolf", "zebra",
];

function randomInt(maxExclusive: number): number {
  // Rejection sampling for an unbiased crypto-random integer.
  const range = 0x100000000;
  const limit = range - (range % maxExclusive);
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0]! >= limit);
  return buf[0]! % maxExclusive;
}

/** Three distinct animals joined by dashes, e.g. "fox-cat-bear" (59,280 combos). */
export function generateAnimalId(): string {
  const pool = [...ANIMALS];
  const picks: string[] = [];
  for (let i = 0; i < 3; i++) {
    picks.push(pool.splice(randomInt(pool.length), 1)[0]!);
  }
  return picks.join("-");
}

/** URL-safe random token of exactly `length` characters. */
export function generateRandomId(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, length);
}

export function generateUuid(): string {
  return crypto.randomUUID();
}

function generateCandidate(idFormat: string, idLength: number): string {
  return idFormat === "animals" ? generateAnimalId() : generateRandomId(idLength);
}

/** True when a D1 error is a UNIQUE / PRIMARY KEY constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed|PRIMARY KEY|constraint failed: public_ids/i.test(err.message)
  );
}

/**
 * Reserve a public id in the shared shares+requests namespace and run the
 * caller-supplied statements in the SAME atomic batch, so the registry row and
 * the share/request row commit (or roll back) together.
 *
 * Uniqueness is enforced by the `public_ids` PRIMARY KEY rather than a
 * check-then-insert read, closing the race where two concurrent creators pass
 * the existence check and then both insert the same id. On a UNIQUE collision
 * the whole batch rolls back and a fresh candidate is tried, up to
 * `MAX_ID_ATTEMPTS` times.
 */
export async function insertWithUniqueId(
  db: D1Database,
  kind: "share" | "request",
  idFormat: string,
  idLength: number,
  buildStatements: (id: string) => D1PreparedStatement[]
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const candidate = generateCandidate(idFormat, idLength);
    const registryInsert = db
      .prepare("INSERT INTO public_ids (id, kind, created_at) VALUES (?, ?, ?)")
      .bind(candidate, kind, utcNow());
    try {
      await db.batch([registryInsert, ...buildStatements(candidate)]);
      return candidate;
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new HTTPException(500, { message: "Failed to generate unique ID" });
}
