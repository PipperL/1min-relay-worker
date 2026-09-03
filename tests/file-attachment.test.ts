import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "../src/types";
import { ApiError, ValidationError } from "../src/utils/errors";
import {
  collectFileAttachmentIds,
  resolveFileInput,
  uploadFileToAsset,
} from "../src/utils/file-attachment";

const ASSET_URL = "https://api.1min.ai/api/assets";

// Shape captured from a live Asset API upload.
const UPLOAD_RESPONSE = {
  asset: {
    key: "documents/2026_09_03_12_43_32_845_relay-probe.txt",
    mimetype: "text/plain",
  },
  fileContent: {
    uuid: "1ca301c7-33e4-440d-8d2c-38dd34e8cf7b",
    path: "documents/2026_09_03_12_43_32_845_relay-probe.txt",
    name: "relay-probe.txt",
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("resolveFileInput", () => {
  it("returns null for a part that already carries an asset id", async () => {
    await expect(
      resolveFileInput({ type: "input_file", file_id: "abc" }),
    ).resolves.toBeNull();
  });

  it("decodes a bare base64 payload", async () => {
    const file = await resolveFileInput({
      type: "input_file",
      file_data: btoa("hello"),
      filename: "note.txt",
    });
    expect(file?.filename).toBe("note.txt");
    expect(new TextDecoder().decode(file?.data)).toBe("hello");
  });

  it("decodes a data: URI and keeps its mime type", async () => {
    const file = await resolveFileInput({
      type: "input_file",
      file_data: `data:text/plain;base64,${btoa("hello")}`,
      filename: "note.txt",
    });
    expect(file?.mimeType).toBe("text/plain");
    expect(new TextDecoder().decode(file?.data)).toBe("hello");
  });

  it("rejects payloads that are not valid base64", async () => {
    await expect(
      resolveFileInput({ type: "input_file", file_data: "!!!not base64!!!" }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses a non-HTTPS file url", async () => {
    await expect(
      resolveFileInput({ type: "input_file", file_url: "http://x/a.pdf" }),
    ).rejects.toThrow(/HTTPS/);
  });

  it("fetches an HTTPS file url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("file bytes", {
            headers: { "Content-Type": "application/pdf; charset=binary" },
          }),
      ),
    );
    const file = await resolveFileInput({
      type: "input_file",
      file_url: "https://example.test/a.pdf",
      filename: "a.pdf",
    });
    expect(file?.mimeType).toBe("application/pdf");
  });

  it("rejects a part with no way to identify the file", async () => {
    await expect(
      resolveFileInput({ type: "input_file" } as FileContent),
    ).rejects.toThrow(/file_id, file_data or file_url/);
  });
});

describe("uploadFileToAsset", () => {
  it("returns fileContent.uuid, not the path or key", async () => {
    // The upstream silently attaches nothing when given a path where a uuid
    // belongs — the model then answers from thin air — so this is the whole
    // point of the function.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(UPLOAD_RESPONSE))),
    );
    const id = await uploadFileToAsset(
      {
        data: new TextEncoder().encode("hi").buffer,
        mimeType: "text/plain",
        filename: "hi.txt",
      },
      "key",
      ASSET_URL,
    );
    expect(id).toBe("1ca301c7-33e4-440d-8d2c-38dd34e8cf7b");
    expect(id).not.toBe(UPLOAD_RESPONSE.fileContent.path);
  });

  it("fails loudly when the upload returns no uuid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ fileContent: { path: "documents/x.txt" } }),
          ),
      ),
    );
    await expect(
      uploadFileToAsset(
        {
          data: new ArrayBuffer(2),
          mimeType: "text/plain",
          filename: "hi.txt",
        },
        "key",
        ASSET_URL,
      ),
    ).rejects.toThrow(ApiError);
  });

  it("reports an upload failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(
      uploadFileToAsset(
        {
          data: new ArrayBuffer(2),
          mimeType: "text/plain",
          filename: "hi.txt",
        },
        "key",
        ASSET_URL,
      ),
    ).rejects.toThrow(/upload file attachment/i);
  });
});

describe("collectFileAttachmentIds", () => {
  it("passes existing ids through and uploads the rest", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(UPLOAD_RESPONSE)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ids = await collectFileAttachmentIds(
      [
        { type: "input_file", file_id: "already-uploaded" },
        { type: "input_file", file_data: btoa("hello"), filename: "a.txt" },
      ],
      "key",
      ASSET_URL,
    );

    expect(ids).toEqual([
      "already-uploaded",
      "1ca301c7-33e4-440d-8d2c-38dd34e8cf7b",
    ]);
    // Only the second part needed a round trip
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns nothing for an empty list", async () => {
    await expect(collectFileAttachmentIds([], "key", ASSET_URL)).resolves.toEqual(
      [],
    );
  });
});
