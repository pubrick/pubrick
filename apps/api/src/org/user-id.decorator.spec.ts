import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { UserId } from "./user-id.decorator";

/**
 * The decorator that answers "who edited this".
 *
 * Its value is written straight to `content_versions.created_by`, so a missing
 * one does not fail loudly at the boundary — it stores a version row with a
 * NULL author, which is EXACTLY the shape an AI-written row has. "Who edited
 * this" would then answer "the model", on the one column the product's whole
 * authorship claim rests on.
 *
 * Tested through the real decorator rather than an exported copy of its body:
 * what has to hold is that `@UserId()` throws, not that some function beside it
 * would have. Nest's `createParamDecorator` hides the factory in route
 * metadata, so it is read back out of there — applying the decorator by hand,
 * which needs no decorator support from the test transform.
 */
function userIdFactory(): (data: unknown, ctx: ExecutionContext) => string {
  class Probe {
    handler(_userId: string) {}
  }
  UserId()(Probe.prototype, "handler", 0);
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, "handler") as Record<
    string,
    { factory: (data: unknown, ctx: ExecutionContext) => string }
  >;
  const entry = Object.values(metadata)[0];
  if (!entry) throw new Error("@UserId() left no route-args metadata to read the factory from");
  return entry.factory;
}

/** An ExecutionContext over one request object, which is all the factory reads. */
const contextFor = (request: unknown): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

describe("@UserId()", () => {
  const factory = userIdFactory();

  it("returns the signed-in user's id", () => {
    expect(factory(undefined, contextFor({ session: { user: { id: "user_123" } } }))).toBe(
      "user_123",
    );
  });

  it("throws on a route without the auth guard, rather than handing back undefined", () => {
    // The mutation this exists for: returning `undefined as unknown as string`
    // here type-checks, passes every other test in the suite, and files an
    // anonymous version row on any route someone forgets to guard.
    expect(() => factory(undefined, contextFor({}))).toThrow(
      "UserId used on a route without the auth guard",
    );
    // better-auth's own "signed out" answer is null, not a missing property.
    expect(() => factory(undefined, contextFor({ session: null }))).toThrow(
      "UserId used on a route without the auth guard",
    );
  });

  it("throws the same exception for a session with no user, not a bare TypeError", () => {
    // `session?.user.id` guards the first hop only: a session object carrying no
    // `user` threw `Cannot read properties of undefined`, which Nest reports as
    // an unexplained 500 instead of the sentence that names the cause.
    expect(() => factory(undefined, contextFor({ session: {} }))).toThrow(
      "UserId used on a route without the auth guard",
    );
  });

  it("refuses an empty id, which would store as anonymous just the same", () => {
    expect(() => factory(undefined, contextFor({ session: { user: { id: "" } } }))).toThrow(
      "UserId used on a route without the auth guard",
    );
    expect(() => factory(undefined, contextFor({ session: { user: { id: 42 } } }))).toThrow(
      "UserId used on a route without the auth guard",
    );
  });
});
