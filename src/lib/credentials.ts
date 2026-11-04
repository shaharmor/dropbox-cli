import { text, withCredentialStoreAsync, type CredentialStore } from "./config";
import { authDeadline, MAX_REFRESH_MS } from "./auth-coordination";
import { log } from "./logger";
import { CredentialError, type AuthRequestOptions, type CredentialSnapshot } from "../types";

const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const REFRESH_MARGIN_SECONDS = 300;

/**
 * Returns the stored credentials for the expected account, refreshing the access token when it
 * is about to expire or when `rejected` (a snapshot Dropbox refused) is still the stored one.
 */
export async function getCredentialSnapshot(
  options: AuthRequestOptions = {},
  rejected?: CredentialSnapshot,
): Promise<CredentialSnapshot> {
  return withCredentialStoreAsync(async store => {
    const auth = store.snapshot();
    if (!auth) throw new CredentialError("auth_error", "Not authenticated. Run `dropbox-cli auth login` first.");

    const expectedAccount = options.expectedAccountId ?? rejected?.account_id;
    if (expectedAccount !== undefined && auth.account_id !== expectedAccount) {
      throw new CredentialError("account_mismatch", "Configured account does not match the requested account.");
    }
    if (options.signal?.aborted) throw new CredentialError("auth_cancelled", "Authentication cancelled.");

    const expiring = Date.now() / 1000 >= auth.expires_at - REFRESH_MARGIN_SECONDS;
    // Another process may already have replaced the rejected token.
    const stillRejected = rejected?.generation === auth.generation;
    if (!expiring && !stillRejected) return auth;
    return refreshAccessToken(store, auth, options);
  }, options.signal);
}

async function refreshAccessToken(
  store: CredentialStore,
  auth: CredentialSnapshot,
  options: AuthRequestOptions,
): Promise<CredentialSnapshot> {
  const config = store.readConfig();
  if (!config) throw new CredentialError("auth_error", "No app credentials found. Run `dropbox-cli auth login` first.");
  const timeoutMs = options.refreshTimeoutMs ?? MAX_REFRESH_MS;
  if (timeoutMs > MAX_REFRESH_MS) {
    throw new CredentialError("auth_timeout", "Refresh deadline exceeds the supported bound.");
  }

  const deadline = authDeadline(timeoutMs, options.signal);
  try {
    log("Refreshing access token...");
    const response = await deadline.wait(fetch(TOKEN_URL, {
      method: "POST",
      signal: deadline.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refresh_token,
        client_id: config.client_id,
        client_secret: config.client_secret,
      }),
    }));
    if (!response.ok) {
      // Only an explicit OAuth refusal means reconnect; throttling or outages are transient.
      if (response.status === 400 || response.status === 401) {
        throw new CredentialError("auth_error", "Token refresh failed. Reconnect the account.");
      }
      throw new CredentialError("connection_error", "Cannot refresh credentials. Check the connection and retry.");
    }

    const data = await deadline.wait(response.json()) as RefreshResponse | null;
    if (!isValidRefresh(data, auth.account_id)) {
      throw new CredentialError("auth_error", "Invalid token refresh response. Reconnect the account.");
    }
    deadline.signal.throwIfAborted();
    store.writeAuth({
      ...auth,
      access_token: data.access_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    }, auth.generation);
    return store.snapshot()!;
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw new CredentialError("connection_error", "Cannot refresh credentials. Check the connection and retry.");
  } finally {
    deadline.close();
  }
}

interface RefreshResponse {
  access_token?: unknown;
  expires_in?: unknown;
  account_id?: unknown;
}

function isValidRefresh(
  data: RefreshResponse | null,
  accountId: string,
): data is { access_token: string; expires_in: number; account_id?: unknown } {
  return !!data &&
    text(data.access_token) &&
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 &&
    (data.account_id === undefined || data.account_id === accountId);
}
