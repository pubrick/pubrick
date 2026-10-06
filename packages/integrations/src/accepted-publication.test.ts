import { describe, expect, it } from "vitest";
import { AcceptedPublicationError, UnknownOutcomePublishError } from "./index.js";

describe("accepted but unconfirmed publication receipt", () => {
  it("keeps a frozen receipt and remains an unknown outcome, without claiming publication", () => {
    const receipt = { externalId: "71", externalUrl: "https://site.example/posts/71" };
    const error = new AcceptedPublicationError(
      "Provider retained the post as pending",
      receipt,
      201,
    );
    receipt.externalId = "later mutation";
    expect(error).toBeInstanceOf(UnknownOutcomePublishError);
    expect(error.message).toBe("Provider retained the post as pending");
    expect(error.status).toBe(201);
    expect(error.receipt).toEqual({
      externalId: "71",
      externalUrl: "https://site.example/posts/71",
    });
    expect(Object.isFrozen(error.receipt)).toBe(true);
  });
});
