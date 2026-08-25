import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { resetNavigation } from "./next-navigation.stub";

afterEach(() => {
  cleanup();
  resetNavigation();
  vi.restoreAllMocks();
});
