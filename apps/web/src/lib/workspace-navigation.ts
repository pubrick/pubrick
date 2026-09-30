/** Leave tenant-local React state and router caches behind after a cookie change. */
export function navigateToWorkspace(locale: string): void {
  window.location.assign(`/${encodeURIComponent(locale)}/brands`);
}
