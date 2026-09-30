import { Injectable } from "@nestjs/common";
import { type AiCallScope, googleProxyFetch } from "@pubrick/ai";
import type { GoogleProxyTestResult } from "@pubrick/shared";
import { throwHostedAiRefusal } from "../hosted-ai-call";

const GOOGLE_CONNECTIVITY_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const PROXY_TEST_TIMEOUT_MS = 8_000;

/** A fixed, unauthenticated Google request proves CONNECT and TLS without a model call. */
@Injectable()
export class GoogleProxyProbe {
  async run(proxyUrl: string, scope?: AiCallScope): Promise<GoogleProxyTestResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);
    try {
      // Any HTTP response from Google's TLS endpoint proves the proxy route.
      // No API key, user text, or generation request is sent.
      const request = async (signal: AbortSignal) => {
        const response = await googleProxyFetch(
          GOOGLE_CONNECTIVITY_URL,
          { method: "GET", redirect: "manual", signal },
          proxyUrl,
        );
        await response.body?.cancel();
      };
      if (scope) await scope(request, controller.signal);
      else await request(controller.signal);
      return { ok: true };
    } catch (error) {
      throwHostedAiRefusal(error);
      // Transport errors can contain proxy userinfo. Only closed codes reach the client.
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
