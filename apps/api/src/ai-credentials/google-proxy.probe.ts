import { Injectable } from "@nestjs/common";
import { googleProxyFetch } from "@pubrick/ai";
import type { GoogleProxyTestResult } from "@pubrick/shared";

const GOOGLE_CONNECTIVITY_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const PROXY_TEST_TIMEOUT_MS = 8_000;

/** A fixed, unauthenticated Google request proves CONNECT and TLS without a model call. */
@Injectable()
export class GoogleProxyProbe {
  async run(proxyUrl: string): Promise<GoogleProxyTestResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);
    try {
      // Any HTTP response from Google's TLS endpoint proves the proxy route.
      // No API key, user text, or generation request is sent.
      const response = await googleProxyFetch(
        GOOGLE_CONNECTIVITY_URL,
        { method: "GET", redirect: "manual", signal: controller.signal },
        proxyUrl,
      );
      await response.body?.cancel();
      return { ok: true };
    } catch {
      // Transport errors can contain proxy userinfo. Only closed codes reach the client.
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
