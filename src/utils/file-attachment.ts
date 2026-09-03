/**
 * File attachments for the 1min.ai chat API.
 *
 * Uploaded files are referenced in `promptObject.attachments.files` by the
 * **`fileContent.uuid`** returned from the Asset API — not by `path` or `key`,
 * which is what images use. This matters more than it looks: passing a path
 * where a uuid belongs does not fail. The upstream accepts the request,
 * silently attaches nothing, and the model answers from thin air. Verified
 * against the live API: the same request answered "Vermilion Otter" (the real
 * contents) with the uuid, and invented a plausible-sounding codename with
 * either of the other two.
 */

import { MAX_ATTACHMENT_FILE_SIZE } from "../constants/config";
import type { FileContent } from "../types";
import { ApiError, ValidationError } from "./errors";

export interface FileData {
  data: ArrayBuffer;
  mimeType: string;
  filename: string;
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function assertWithinSizeLimit(byteLength: number, filename: string): void {
  if (byteLength > MAX_ATTACHMENT_FILE_SIZE) {
    const limitMb = Math.floor(MAX_ATTACHMENT_FILE_SIZE / (1024 * 1024));
    throw new ValidationError(
      `Attachment '${filename}' is larger than the ${limitMb}MB upload limit`,
      "input",
      "file_too_large",
    );
  }
}

/**
 * Resolve an `input_file` content part into bytes ready for upload.
 * Returns null when the part already references an uploaded asset.
 */
export async function resolveFileInput(
  part: FileContent,
): Promise<FileData | null> {
  // Already uploaded — the client passes the asset id straight through
  if (part.file_id) return null;

  const filename = part.filename || `attachment-${crypto.randomUUID()}`;

  if (part.file_data) {
    // Accept both a bare base64 payload and a full data: URI
    const dataUriMatch = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(
      part.file_data,
    );
    const mimeType = dataUriMatch?.[1] ?? "application/octet-stream";
    const base64 = dataUriMatch?.[2] ?? part.file_data;

    let data: ArrayBuffer;
    try {
      data = decodeBase64(base64);
    } catch {
      throw new ValidationError(
        `Attachment '${filename}' is not valid base64 data`,
        "input",
        "invalid_file_data",
      );
    }
    assertWithinSizeLimit(data.byteLength, filename);
    return { data, mimeType, filename };
  }

  if (part.file_url) {
    // Same SSRF guard as image URLs
    if (!part.file_url.startsWith("https://")) {
      throw new ValidationError(
        "Only HTTPS file URLs are supported",
        "input",
        "unsupported_file_url",
      );
    }
    const response = await fetch(part.file_url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; 1min-relay-worker/1.0; +https://1min.ai)",
      },
    });
    if (!response.ok) {
      throw new ApiError(
        `Failed to fetch attachment '${filename}': ${response.status}`,
        422,
      );
    }
    const data = await response.arrayBuffer();
    assertWithinSizeLimit(data.byteLength, filename);
    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "application/octet-stream";
    return { data, mimeType, filename };
  }

  throw new ValidationError(
    "An input_file part needs one of file_id, file_data or file_url",
    "input",
    "invalid_file_part",
  );
}

/**
 * Upload a file to the 1min.ai Asset API and return its `fileContent.uuid`,
 * which is what `attachments.files` expects.
 */
export async function uploadFileToAsset(
  file: FileData,
  apiKey: string,
  assetUrl: string,
): Promise<string> {
  const formData = new FormData();
  formData.append(
    "asset",
    new Blob([file.data], { type: file.mimeType }),
    file.filename,
  );

  const response = await fetch(assetUrl, {
    method: "POST",
    headers: { "API-KEY": apiKey },
    body: formData,
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    console.error(
      `1min.ai asset upload failed: ${response.status} ${response.statusText}`,
      detail,
    );
    throw new ApiError("Failed to upload file attachment", 422);
  }

  const result = (await response.json()) as {
    fileContent?: { uuid?: string };
  };

  // Refuse to continue without a uuid rather than sending an id the upstream
  // will quietly ignore — see the note at the top of this file.
  if (!result.fileContent?.uuid) {
    throw new ApiError("Asset API returned no file id for the attachment", 502);
  }

  return result.fileContent.uuid;
}

/**
 * Turn the `input_file` parts of a message into asset ids, uploading whatever
 * is not already stored.
 */
export async function collectFileAttachmentIds(
  parts: FileContent[],
  apiKey: string,
  assetUrl: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const part of parts) {
    if (part.file_id) {
      ids.push(part.file_id);
      continue;
    }
    const file = await resolveFileInput(part);
    if (file) {
      ids.push(await uploadFileToAsset(file, apiKey, assetUrl));
    }
  }
  return ids;
}
