import crypto from "node:crypto";

export type Role = "Admin" | "Release Manager" | "Viewer";

export type Permission =
  | "assessments:read"
  | "assessments:create"
  | "assessments:merge"
  | "assessments:override"
  | "assessments:deploy"
  | "policies:read"
  | "policies:write"
  | "apikeys:read"
  | "apikeys:write"
  | "audit:read"
  | "sandbox:reset"
  | "webhooks:test";

const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  Viewer: new Set<Permission>([
    "assessments:read",
    "policies:read",
    "audit:read",
  ]),
  "Release Manager": new Set<Permission>([
    "assessments:read",
    "assessments:create",
    "assessments:merge",
    "assessments:override",
    "assessments:deploy",
    "policies:read",
    "audit:read",
  ]),
  Admin: new Set<Permission>([
    "assessments:read",
    "assessments:create",
    "assessments:merge",
    "assessments:override",
    "assessments:deploy",
    "policies:read",
    "policies:write",
    "apikeys:read",
    "apikeys:write",
    "audit:read",
    "sandbox:reset",
    "webhooks:test",
  ]),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function isValidRole(value: unknown): value is Role {
  return value === "Admin" || value === "Release Manager" || value === "Viewer";
}

// ---------------------------------------------------------------------------
// Scrypt Password Hashing (server-side only, random per-user salt)
// ---------------------------------------------------------------------------
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hexHash] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hexHash, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// HS256 JWT Implementation (zero external dependencies)
// ---------------------------------------------------------------------------
export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  orgId: string;
  role: Role;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf-8");
}

export function signJwt(
  claims: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  ttlSeconds = 3600 * 8
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      ...claims,
      iat: now,
      exp: now + ttlSeconds,
    })
  );
  const sig = base64UrlEncode(
    crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expectedSig = base64UrlEncode(
    crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest()
  );
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (!parsed.exp || parsed.exp < now) return null;
    if (!parsed.orgId || !isValidRole(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scoped Enterprise API Keys (stored hashed via SHA-256)
// ---------------------------------------------------------------------------
export interface StoredApiKey {
  id: string;
  orgId: string;
  name: string;
  role: Role;
  prefix: string;
  keyHash: string;
  createdBy: string;
  createdAt: string;
  revoked: boolean;
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function createApiKeyRecord(params: {
  orgId: string;
  name: string;
  role: Role;
  createdBy: string;
}): { rawKey: string; record: StoredApiKey } {
  const randomPart = crypto.randomBytes(24).toString("hex");
  const rawKey = `dg_live_${randomPart}`;
  const prefix = `${rawKey.slice(0, 14)}...${rawKey.slice(-4)}`;
  const record: StoredApiKey = {
    id: `key_${crypto.randomBytes(4).toString("hex")}`,
    orgId: params.orgId,
    name: params.name,
    role: params.role,
    prefix,
    keyHash: hashApiKey(rawKey),
    createdBy: params.createdBy,
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  return { rawKey, record };
}

export function matchApiKey(rawKey: string, keys: StoredApiKey[]): StoredApiKey | null {
  if (!rawKey || !rawKey.startsWith("dg_live_")) return null;
  const candidateHash = Buffer.from(hashApiKey(rawKey), "hex");
  for (const key of keys) {
    if (key.revoked) continue;
    const storedBuf = Buffer.from(key.keyHash, "hex");
    if (
      storedBuf.length === candidateHash.length &&
      crypto.timingSafeEqual(storedBuf, candidateHash)
    ) {
      return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Constant-Time GitHub HMAC SHA-256 Webhook Verification
// ---------------------------------------------------------------------------
export function signWebhookPayload(payload: string | Buffer, secret: string): string {
  const digest = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(
  payload: string | Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!secret || !signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = signWebhookPayload(payload, secret);
  const sigBuf = Buffer.from(signatureHeader);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}
