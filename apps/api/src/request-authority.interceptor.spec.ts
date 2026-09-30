import type { ExecutionContext } from "@nestjs/common";
import { firstValueFrom, Observable } from "rxjs";
import { describe, expect, it } from "vitest";
import {
  currentRequestAuthority,
  REQUEST_AUTHORITY,
  type RequestAuthority,
  runWithRequestAuthority,
} from "./request-authority";
import { RequestAuthorityInterceptor } from "./request-authority.interceptor";

const actor = (orgId: string): RequestAuthority =>
  Object.freeze({ kind: "api-key", orgId, keyId: `${orgId}-key`, scope: "content:read" });
function context(authority?: RequestAuthority): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ [REQUEST_AUTHORITY]: authority }) }),
  } as unknown as ExecutionContext;
}
describe("trusted request authority subscription", () => {
  it("keeps concurrent lazy handler asynchronous work in its own actor context", async () => {
    const interceptor = new RequestAuthorityInterceptor();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const handler = {
      handle: () =>
        new Observable<string>((subscriber) => {
          const before = currentRequestAuthority()?.orgId;
          void gate.then(() => {
            const after = currentRequestAuthority()?.orgId;
            seen.push(`${before}:${after}`);
            subscriber.next(after ?? "missing");
            subscriber.complete();
          });
        }),
    };
    const first = firstValueFrom(interceptor.intercept(context(actor("first")), handler));
    const second = firstValueFrom(interceptor.intercept(context(actor("second")), handler));
    expect(currentRequestAuthority()).toBeUndefined();
    release?.();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(seen.sort()).toEqual(["first:first", "second:second"]);
    expect(currentRequestAuthority()).toBeUndefined();
  });
  it("clears enclosing authority for public routes and forwards cancellation teardown", () => {
    const interceptor = new RequestAuthorityInterceptor();
    let teardown = 0;
    runWithRequestAuthority(actor("outer"), () => {
      const subscription = interceptor
        .intercept(context(), {
          handle: () =>
            new Observable(() => {
              expect(currentRequestAuthority()).toBeUndefined();
              return () => {
                teardown++;
              };
            }),
        })
        .subscribe();
      expect(currentRequestAuthority()?.orgId).toBe("outer");
      subscription.unsubscribe();
    });
    expect(teardown).toBe(1);
    expect(currentRequestAuthority()).toBeUndefined();
  });
  it("forwards asynchronous errors without leaking authority", async () => {
    const refusal = new Error("handler refused");
    const stream = new RequestAuthorityInterceptor().intercept(context(actor("error")), {
      handle: () =>
        new Observable((subscriber) => {
          queueMicrotask(() => {
            expect(currentRequestAuthority()?.orgId).toBe("error");
            subscriber.error(refusal);
          });
        }),
    });
    await expect(firstValueFrom(stream)).rejects.toBe(refusal);
    expect(currentRequestAuthority()).toBeUndefined();
  });
});
