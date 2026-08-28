import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { resetStubSession } from "./auth-client.stub";
import { resetNavigation } from "./next-navigation.stub";

afterEach(() => {
  cleanup();
  resetNavigation();
  resetStubSession();
  vi.restoreAllMocks();
});
