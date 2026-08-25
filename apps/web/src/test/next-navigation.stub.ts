import { vi } from "vitest";

/** Spies tests assert on; reset from setup.ts after every test. */
export const routerMock = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

export const navigationState = {
  pathname: "/en",
  params: {} as Record<string, string | string[]>,
  searchParams: new URLSearchParams(),
};

export function resetNavigation(): void {
  for (const fn of Object.values(routerMock)) fn.mockReset();
  navigationState.pathname = "/en";
  navigationState.params = {};
  navigationState.searchParams = new URLSearchParams();
}

export const useRouter = () => routerMock;
export const usePathname = () => navigationState.pathname;
export const useParams = () => navigationState.params;
export const useSearchParams = () => navigationState.searchParams;
export const useSelectedLayoutSegment = () => null;
export const redirect = vi.fn();
export const notFound = vi.fn();
