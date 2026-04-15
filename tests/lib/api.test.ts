import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock config module
const mockReadAuth = mock();
const mockReadConfig = mock();
const mockWriteAuth = mock();

mock.module("../../src/lib/config", () => ({
  readAuth: mockReadAuth,
  readConfig: mockReadConfig,
  writeAuth: mockWriteAuth,
  writeConfig: mock(),
  clearAuth: mock(),
}));



let capturedError: { code: string; message: string } | null = null;

mock.module("../../src/lib/output", () => ({
  printError: (code: string, message: string) => {
    capturedError = { code, message };
    throw new Error(`EXIT:${code}`);
  },
  printAuthError: (message: string) => {
    capturedError = { code: "auth_error", message };
    throw new Error("EXIT:auth_error");
  },
}));

import { rpc, rpcRaw, contentUpload, contentDownload, pollBatchJob } from "../../src/lib/api";

const validAuth = {
  access_token: "test-token",
  refresh_token: "test-refresh",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  account_id: "dbid:test",
  account_email: "test@example.com",
};

const validConfig = {
  client_id: "test-client-id",
  client_secret: "test-client-secret",
};

describe("api", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    mockReadAuth.mockReset();
    mockReadConfig.mockReset();
    mockWriteAuth.mockReset();
    capturedError = null;

    mockReadAuth.mockReturnValue(validAuth);
    mockReadConfig.mockReturnValue(validConfig);

    fetchMock = mock();
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("rpc", () => {
    test("makes authenticated POST to RPC endpoint", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: [] }), { status: 200 })
      );

      const result = await rpc("files/list_folder", { path: "" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.dropboxapi.com/2/files/list_folder",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ path: "" }),
        })
      );
      expect(result).toEqual({ entries: [] });
    });

    test("includes Authorization header", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );

      await rpc("files/list_folder", {});

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    test("parses Dropbox error response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { ".tag": "not_found" },
            error_summary: "path/not_found/.",
          }),
          { status: 409 }
        )
      );

      await expect(rpc("files/get_metadata", { path: "/x" })).rejects.toThrow(
        "EXIT:not_found"
      );
      expect(capturedError).toEqual({
        code: "not_found",
        message: "path/not_found/.",
      });
    });

    test("exits when not authenticated", async () => {
      mockReadAuth.mockReturnValue(null);

      await expect(rpc("files/list_folder", { path: "" })).rejects.toThrow(
        "EXIT:auth_error"
      );
    });

    test("sends empty body object by default", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );

      await rpc("files/list_folder");

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(opts.body).toBe(JSON.stringify({}));
    });
  });

  describe("rpcRaw", () => {
    test("returns raw success response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "https://..." }), { status: 200 })
      );

      const result = await rpcRaw("sharing/create_shared_link", { path: "/test" });

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ url: "https://..." });
    });

    test("returns raw error response without throwing", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { ".tag": "shared_link_already_exists" },
            error_summary: "shared_link_already_exists/.",
          }),
          { status: 409 }
        )
      );

      const result = await rpcRaw("sharing/create_shared_link", {});

      expect(result.ok).toBe(false);
      expect(result.status).toBe(409);
      expect((result.data as any).error[".tag"]).toBe(
        "shared_link_already_exists"
      );
    });
  });

  describe("contentUpload", () => {
    test("uploads content with metadata in Dropbox-API-Arg header", async () => {
      const metadata = { path: "/test.txt", mode: { ".tag": "add" } };
      const content = new Uint8Array([1, 2, 3]);

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "test.txt", size: 3 }), {
          status: 200,
        })
      );

      const result = await contentUpload("files/upload", metadata, content);

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://content.dropboxapi.com/2/files/upload");
      const headers = opts.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(headers["Dropbox-API-Arg"]).toBe(JSON.stringify(metadata));
      expect(result).toEqual({ name: "test.txt", size: 3 });
    });
  });

  describe("contentDownload", () => {
    test("downloads content with metadata from response header", async () => {
      const metadata = { name: "test.txt", size: 5 };
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([72, 101, 108, 108, 111]));
          controller.close();
        },
      });

      fetchMock.mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "Dropbox-API-Result": JSON.stringify(metadata) },
        })
      );

      const result = await contentDownload("files/download", {
        path: "/test.txt",
      });

      expect(result.metadata).toEqual(metadata);
      expect(result.body).toBeDefined();
    });

    test("uses content.dropboxapi.com base URL", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("", {
          status: 200,
          headers: { "Dropbox-API-Result": "{}" },
        })
      );

      await contentDownload("files/download", { path: "/x" });

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("https://content.dropboxapi.com/2/files/download");
    });
  });

  describe("pollBatchJob", () => {
    test("returns immediately when job is already complete", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ".tag": "complete",
            entries: [{ ".tag": "success" }],
          }),
          { status: 200 }
        )
      );

      const result = await pollBatchJob(
        "files/copy_batch/check_v2",
        "job-123"
      );
      expect(result).toEqual({
        ".tag": "complete",
        entries: [{ ".tag": "success" }],
      });
    });

    test("polls until complete", async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ".tag": "in_progress" }), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ".tag": "complete", entries: [] }),
            { status: 200 }
          )
        );

      const result = await pollBatchJob(
        "files/copy_batch/check_v2",
        "job-123"
      );
      expect(result).toEqual({ ".tag": "complete", entries: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("exits on batch failure", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ".tag": "failed" }), { status: 200 })
      );

      await expect(
        pollBatchJob("files/copy_batch/check_v2", "job-123")
      ).rejects.toThrow("EXIT:batch_error");
    });
  });

  describe("token refresh", () => {
    test("auto-refreshes token when near expiry", async () => {
      const nearExpiryAuth = {
        ...validAuth,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
      mockReadAuth.mockReturnValueOnce(nearExpiryAuth);

      // Token refresh response
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "new-token", expires_in: 14400 }),
          { status: 200 }
        )
      );

      // After refresh, readAuth returns updated auth
      mockReadAuth.mockReturnValueOnce({
        ...validAuth,
        access_token: "new-token",
      });

      // The actual RPC call
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ entries: [] }), { status: 200 })
      );

      await rpc("files/list_folder", { path: "" });

      expect(mockWriteAuth).toHaveBeenCalled();
    });
  });

  describe("retry logic", () => {
    test("retries on 429 rate limit", async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response("", {
            status: 429,
            headers: { "Retry-After": "0" },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), { status: 200 })
        );

      const result = await rpc("files/list_folder", { path: "" });
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("retries on 500 server error", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), { status: 200 })
        );

      const result = await rpc("files/list_folder", { path: "" });
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
