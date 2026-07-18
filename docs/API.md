# Programmatic API (`/api/v1/`)

Bearer-token endpoints for scripts and agents. All requests use:

```
Authorization: Bearer $API_BEARER_TOKEN
Content-Type: application/json
```

Errors return `{"detail": "message"}` with an appropriate HTTP status.

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

`GET /api/v1/cost` - storage totals and estimated monthly R2 cost.

## Public endpoints (no auth)

Used by the web UI; also callable directly:

- `GET /api/public/shares/{id}` - metadata (file list hidden if password-protected)
- `POST /api/public/shares/{id}/unlock` - `{"password": "..."}` → file list
- `POST /api/public/shares/{id}/download` - `{"password": "..."}`` (if protected) → download URLs, increments the counter
- `GET /api/public/requests/{id}` - request metadata
- `POST /api/public/requests/{id}/upload` - same body as share files → upload URLs
- `POST /api/public/requests/{id}/complete-multipart` - as above
- `POST /api/public/requests/{id}/confirm` - `{"file_ids": [...], "message": "optional"}`

Password endpoints lock out after 3 failed attempts per 15 minutes.
