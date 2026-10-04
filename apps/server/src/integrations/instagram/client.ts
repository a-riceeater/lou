import { createHmac } from "node:crypto";
import { LouError } from "@lou/shared";
import { safeEqual } from "../../security/crypto";
import { fetchJson, type FetchLike } from "../http";
import type { RefreshResult } from "../manager";

/**
 * Instagram API with Instagram Login (professional accounts): OAuth, long-lived
 * tokens, conversations/messages, the Send API, and webhook signature checks.
 */
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"];
const GRAPH = "https://graph.instagram.com/v23.0";

export class InstagramOAuth {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly redirectUri: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: INSTAGRAM_SCOPES.join(","),
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${params}`;
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; userId: string; expiresIn?: number }> {
    const short = await fetchJson<{ access_token: string; user_id: number | string }>(this.fetchImpl, "https://api.instagram.com/oauth/access_token", {
      service: "Instagram",
      body: new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret, grant_type: "authorization_code", redirect_uri: this.redirectUri, code }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const long = await fetchJson<{ access_token: string; expires_in: number }>(
      this.fetchImpl,
      `https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: this.appSecret, access_token: short.access_token })}`,
      { service: "Instagram" },
    );
    return { accessToken: long.access_token, userId: String(short.user_id), expiresIn: long.expires_in };
  }

  /** Long-lived tokens are refreshed (not via a refresh token) while still valid. */
  async refresh(accessToken: string): Promise<RefreshResult> {
    try {
      const res = await fetchJson<{ access_token: string; expires_in: number }>(
        this.fetchImpl,
        `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: accessToken })}`,
        { service: "Instagram" },
      );
      return { accessToken: res.access_token, expiresInSeconds: res.expires_in };
    } catch (err) {
      if (err instanceof LouError && (err.code === "AUTH_REQUIRED" || err.code === "UPSTREAM_ERROR")) {
        throw new LouError("AUTH_REQUIRED", "Instagram needs you to sign in again.");
      }
      throw err;
    }
  }

  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    if (!header?.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", this.appSecret).update(rawBody).digest("hex")}`;
    return safeEqual(expected, header);
  }
}

export interface IgMessage {
  id: string;
  createdTime: string;
  from: { id: string; username?: string };
  text: string;
}

export class InstagramClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async me(): Promise<{ user_id: string; username: string; name?: string }> {
    return this.get(`${GRAPH}/me?fields=user_id,username,name`);
  }

  async conversations(limit: number): Promise<Array<{ id: string; updatedTime: string; participants: Array<{ id: string; username?: string }>; lastMessage: string }>> {
    const res = await this.get<{ data: Array<{ id: string; updated_time: string; participants?: { data: Array<{ id: string; username?: string }> }; messages?: { data: Array<{ message?: string }> } }> }>(
      `${GRAPH}/me/conversations?${new URLSearchParams({ platform: "instagram", limit: String(limit), fields: "id,updated_time,participants,messages.limit(1){message,from,created_time}" })}`,
    );
    return res.data.map((c) => ({
      id: c.id,
      updatedTime: c.updated_time,
      participants: c.participants?.data ?? [],
      lastMessage: (c.messages?.data[0]?.message ?? "").slice(0, 500),
    }));
  }

  async messages(conversationId: string, limit: number): Promise<IgMessage[]> {
    const res = await this.get<{ messages?: { data: Array<{ id: string; created_time: string; from: { id: string; username?: string }; message?: string }> } }>(
      `${GRAPH}/${encodeURIComponent(conversationId)}?${new URLSearchParams({ fields: `messages.limit(${limit}){id,created_time,from,message}` })}`,
    );
    return (res.messages?.data ?? []).map((m) => ({ id: m.id, createdTime: m.created_time, from: m.from, text: (m.message ?? "").slice(0, 4000) })).reverse();
  }

  async userProfile(igScopedId: string): Promise<{ username?: string; name?: string }> {
    return this.get<{ username?: string; name?: string }>(`${GRAPH}/${encodeURIComponent(igScopedId)}?fields=username,name`).catch(() => ({}));
  }

  async send(igUserId: string, recipientId: string, text: string): Promise<{ messageId: string }> {
    const token = await this.token();
    const res = await fetchJson<{ message_id: string }>(this.fetchImpl, `${GRAPH}/${encodeURIComponent(igUserId)}/messages`, {
      service: "Instagram",
      headers: { authorization: `Bearer ${token}` },
      json: { recipient: { id: recipientId }, message: { text } },
    });
    return { messageId: res.message_id };
  }

  private async get<T>(url: string): Promise<T> {
    const token = await this.token();
    return fetchJson<T>(this.fetchImpl, url, { service: "Instagram", headers: { authorization: `Bearer ${token}` } });
  }
}
