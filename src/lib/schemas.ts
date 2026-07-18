/** Zod schemas mirroring the original pydantic request models. */

import { z } from "zod";

/** Strip path components, control characters and leading dots from filenames. */
const filenameSchema = z
  .string()
  .min(1)
  .max(512)
  .transform((v, ctx) => {
    let name = v.replace(/\\/g, "/");
    name = name.split("/").pop() ?? "";
    // eslint-disable-next-line no-control-regex
    name = name.replace(/[\x00-\x1f]/g, "");
    name = name.replace(/^\.+/, "");
    if (!name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Filename is empty after sanitization" });
      return z.NEVER;
    }
    return name;
  });

/** MIME type: two "/"-separated tokens of visible ASCII only. The strict
 * character class (0x21-0x7e) rejects control characters - notably CR/LF -
 * so a crafted content_type can never inject headers when this value is
 * later passed to the Headers constructor in r2.ts. */
const contentTypeSchema = z
  .string()
  .max(256)
  // eslint-disable-next-line no-control-regex
  .regex(/^[\x21-\x7e]+\/[\x21-\x7e]+$/, "Invalid content type")
  .default("application/octet-stream");

export const fileInputSchema = z.object({
  filename: filenameSchema,
  content_type: contentTypeSchema,
  size: z.number().int().positive(),
});

const idFormatSchema = z.enum(["animals", "random"]);
const idLengthSchema = z.number().int().min(4).max(64).default(10);
const passwordSchema = z.string().min(1).max(128).nullish();

/** Upper-bounded expiry window. The cap prevents a runaway value from
 * overflowing the Date arithmetic used to compute expires_at (which would
 * surface as a 500). ~10 years is well beyond any legitimate use. */
const MAX_EXPIRY_DAYS = 3650;
const expiryDaysSchema = z.number().positive().max(MAX_EXPIRY_DAYS).nullish();

export const shareInitSchema = z.object({
  files: z.array(fileInputSchema).min(1).max(100),
  expiry_days: expiryDaysSchema,
  max_downloads: z.number().int().min(1).nullish(),
  password: passwordSchema,
  title: z.string().max(256).nullish(),
  // Default to non-enumerable random slugs so share links can't be guessed.
  id_format: idFormatSchema.default("random"),
  id_length: idLengthSchema,
});

export const requestCreateSchema = z.object({
  title: z.string().min(1).max(256),
  message: z.string().max(2048).nullish(),
  expiry_days: expiryDaysSchema,
  max_uploads: z.number().int().min(1).nullish(),
  max_file_size: z.number().int().min(1).nullish(),
  allow_incremental: z.boolean().default(false),
  password: passwordSchema,
  id_format: idFormatSchema.default("random"),
  id_length: idLengthSchema,
});

export const completeMultipartSchema = z.object({
  file_id: z.string().min(1),
  upload_id: z.string().min(1),
  parts: z
    .array(z.object({ part_number: z.number().int().min(1), etag: z.string() }))
    .min(1),
});

export const loginSchema = z.object({
  email: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
});

export const shareUnlockSchema = z.object({ password: z.string() });

export const shareDownloadSchema = z.object({ password: z.string().nullish() }).default({});

export const requestUploadSchema = z.object({
  files: z.array(fileInputSchema).min(1).max(100),
  message: z.string().max(2048).nullish(),
  password: z.string().max(128).nullish(),
});

export const requestConfirmSchema = z.object({
  file_ids: z.array(z.string().min(1)).min(1),
  message: z.string().max(2048).nullish(),
});

/** Parse a JSON body against a schema, returning 400 {detail} on failure. */
export async function parseBody<T extends z.ZodTypeAny>(
  req: { json: () => Promise<unknown> },
  schema: T
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = undefined;
  }
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") || "body";
    const { HTTPException } = await import("hono/http-exception");
    throw new HTTPException(400, { message: `${where}: ${first?.message ?? "Invalid request"}` });
  }
  return result.data;
}
