import { NextResponse } from "next/server";

/*
 * Shared protections for the public form endpoints (/api/order and
 * /api/custom-order-quote):
 *
 * - readJsonBody: rejects bodies over MAX_BODY_BYTES before parsing them.
 * - isHoneypotFilled: a hidden "website" field real visitors never see. Bots
 *   that fill every input get a fake success so they don't retry.
 * - rateLimited: a per-IP limit kept in memory. Vercel can run several copies
 *   of a function, each with its own memory, so this is a backstop; the main
 *   limit should be a Vercel Firewall rate-limit rule on /api/*.
 * - clip / FIELD_LIMITS: maximum lengths, enforced on the server whatever the
 *   browser sends.
 */

export const HONEYPOT_FIELD = "website";

// Any real submission is a few KB at most
const MAX_BODY_BYTES = 32 * 1024;

export const FIELD_LIMITS = {
  short: 120, // names, makes, models, part names
  email: 254, // the longest valid email address
  phone: 40,
  medium: 500, // dimensions, addresses, meetup/drop-off details
  long: 5000, // descriptions, comments, notes
} as const;

const RATE_LIMIT = 5; // submissions...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ...per IP per 10 minutes
const hits = new Map<string, number[]>();

export function clientIp(request: Request): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

export function rateLimited(request: Request): boolean {
  const ip = clientIp(request);
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  // Keep the map from growing without bound on a long-lived instance
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
    }
  }

  return recent.length > RATE_LIMIT;
}

export function tooManyRequests() {
  return NextResponse.json(
    { error: "Too many submissions from your connection. Try again in a few minutes." },
    { status: 429, headers: { "Retry-After": String(RATE_WINDOW_MS / 1000) } },
  );
}

type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

export async function readJsonBody(request: Request): Promise<BodyResult> {
  const tooLarge = () => ({
    ok: false as const,
    response: NextResponse.json(
      { error: "That submission is too large. Shorten it and try again." },
      { status: 413 },
    ),
  });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return tooLarge();

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return tooLarge();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "We couldn't read that submission. Try again." },
        { status: 400 },
      ),
    };
  }
}

export function isHoneypotFilled(body: Record<string, unknown>): boolean {
  const value = body[HONEYPOT_FIELD];
  return typeof value === "string" && value.trim() !== "";
}

/** Trimmed string, or undefined when missing or not a string. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

/** Returns the name of the first field over its limit, or null if all fit. */
export function firstTooLong(fields: Record<string, [string | undefined, number]>): string | null {
  for (const [name, [value, max]] of Object.entries(fields)) {
    if (value && value.length > max) return name;
  }
  return null;
}

/** Strips line breaks so user text can't add lines to an email subject. */
export function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}
