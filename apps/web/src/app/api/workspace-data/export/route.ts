export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stream private exports outside Next's 30-second rewrite proxy timeout. */
export async function GET(request: Request): Promise<Response> {
  const origin = process.env.API_INTERNAL_URL ?? "http://localhost:3001";
  try {
    const upstream = await fetch(`${origin}/api/workspace-data/export`, {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(50 * 60 * 1000)]),
    });
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of ["content-type", "content-disposition"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return Response.json(
      { message: "Workspace export is unavailable. Try again shortly." },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
