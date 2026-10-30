import { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const origin = request.headers.get("origin");
  // Next.js may normalize nextUrl to localhost even when the browser uses 127.0.0.1.
  const host = request.headers.get("host");
  let sameOrigin = false;
  try {
    sameOrigin = !!origin && new URL(origin).host === host;
  } catch {
    /* reject invalid origins */
  }
  if (request.method !== "GET" && !sameOrigin)
    return Response.json(
      { detail: "Same-origin request required" },
      { status: 403 },
    );
  const { path } = await context.params;
  if (path.some((p) => !/^[a-zA-Z0-9_-]+$/.test(p)))
    return Response.json({ detail: "Invalid path" }, { status: 400 });
  try {
    const response = await fetch(
      `${process.env.API_INTERNAL_URL || "http://127.0.0.1:8000"}/api/${path.join("/")}${request.nextUrl.search}`,
      {
        method: request.method,
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          "X-Human-Key": process.env.CONTROL_HUMAN_KEY || "",
        },
        ...(request.method !== "GET" ? { body: await request.text() } : {}),
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") || "application/json",
        ...(response.headers.get("Content-Disposition")
          ? {
              "Content-Disposition": response.headers.get(
                "Content-Disposition",
              )!,
            }
          : {}),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { detail: "API unavailable. Check the backend connection." },
      { status: 503 },
    );
  }
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT };
