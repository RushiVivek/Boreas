/// <reference types="@cloudflare/workers-types" />

interface Env {
  LINKS: KVNamespace;
  BOREAS_TOKEN: string;
}

type Meta = { hits: number; createdAt: string };

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED = new Set(["_links", "_health", "favicon.ico", "robots.txt"]);

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const methodNotAllowed = (allow: string): Response =>
  new Response(JSON.stringify({ detail: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", allow },
  });

const constantTimeEq = (a: string, b: string): boolean => {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
};

const unauthorized = (): Response =>
  new Response(JSON.stringify({ detail: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="boreas"',
    },
  });

const requireAdmin = (req: Request, env: Env): Response | null => {
  if (!env.BOREAS_TOKEN) return unauthorized();
  const got = req.headers.get("authorization") ?? "";
  if (!constantTimeEq(got, `Bearer ${env.BOREAS_TOKEN}`)) return unauthorized();
  return null;
};

const validSlug = (s: string) => !RESERVED.has(s) && SLUG_RE.test(s);

const safeDecode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown>> {
  const raw = await req.json().catch(() => null);
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

const validUrl = (u: string) => {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

async function listLinks(env: Env): Promise<Response> {
  const out: { slug: string; url: string; hits: number; createdAt: string }[] =
    [];
  let cursor: string | undefined;
  do {
    const page = await env.LINKS.list<Meta>({ cursor });
    for (const k of page.keys) {
      const url = await env.LINKS.get(k.name);
      if (!url) continue;
      const meta = k.metadata ?? { hits: 0, createdAt: "" };
      out.push({ slug: k.name, url, hits: meta.hits, createdAt: meta.createdAt });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json(out);
}

async function upsertLink(
  slug: string,
  body: { url?: unknown },
  env: Env,
  allowExisting: boolean,
): Promise<Response> {
  if (!validSlug(slug)) return json({ detail: "invalid slug" }, 400);
  if (typeof body.url !== "string" || !validUrl(body.url)) {
    return json({ detail: "invalid url" }, 400);
  }
  const existing = await env.LINKS.getWithMetadata<Meta>(slug);
  if (existing.value !== null && !allowExisting) {
    return json({ detail: "slug already exists" }, 409);
  }
  const meta: Meta = existing.metadata ?? {
    hits: 0,
    createdAt: new Date().toISOString(),
  };
  await env.LINKS.put(slug, body.url, { metadata: meta });
  return json(
    { slug, url: body.url, hits: meta.hits, createdAt: meta.createdAt },
    existing.value === null ? 201 : 200,
  );
}

async function deleteLink(slug: string, env: Env): Promise<Response> {
  const existing = await env.LINKS.get(slug);
  if (existing === null) return json({ detail: "not found" }, 404);
  await env.LINKS.delete(slug);
  return new Response(null, { status: 204 });
}

async function redirect(
  slug: string,
  env: Env,
  ctx: ExecutionContext,
  countHit: boolean,
): Promise<Response> {
  if (RESERVED.has(slug)) return json({ detail: "not found" }, 404);
  const got = await env.LINKS.getWithMetadata<Meta>(slug);
  if (got.value === null) return json({ detail: "not found" }, 404);
  if (countHit) {
    const meta: Meta = got.metadata ?? { hits: 0, createdAt: "" };
    ctx.waitUntil(
      env.LINKS.put(slug, got.value, {
        metadata: { hits: meta.hits + 1, createdAt: meta.createdAt },
      }),
    );
  }
  return new Response(null, {
    status: 302,
    headers: { location: got.value, "referrer-policy": "no-referrer" },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/_health") return json({ status: "ok" });

    if (path === "/_links") {
      const auth = requireAdmin(req, env);
      if (auth) return auth;
      if (method === "GET") return listLinks(env);
      if (method === "POST") {
        const body = await readJsonObject(req);
        if (typeof body.slug !== "string") {
          return json({ detail: "slug required" }, 400);
        }
        return upsertLink(body.slug, body, env, false);
      }
      return methodNotAllowed("GET, POST");
    }

    const linkMatch = path.match(/^\/_links\/([^/]+)$/);
    if (linkMatch) {
      const auth = requireAdmin(req, env);
      if (auth) return auth;
      const slug = safeDecode(linkMatch[1]!);
      if (slug === null) return json({ detail: "not found" }, 404);
      if (method === "PUT") {
        const body = await readJsonObject(req);
        return upsertLink(slug, body, env, true);
      }
      if (method === "DELETE") return deleteLink(slug, env);
      return methodNotAllowed("PUT, DELETE");
    }

    if (path === "/") {
      return new Response(
        "<h1>boreas</h1><p>the north wind blows your link forward.</p>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (method === "GET" || method === "HEAD") {
      const slug = safeDecode(path.slice(1));
      if (slug === null) return json({ detail: "not found" }, 404);
      return redirect(slug, env, ctx, method === "GET");
    }

    return json({ detail: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
