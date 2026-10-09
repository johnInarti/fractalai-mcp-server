/**
 * Thin, honest HTTP client for the live FractalAI endpoints that back this MCP server.
 *
 * All calls hit the real, public deployment at https://fractalai.net.co unless
 * FRACTALAI_BASE_URL is set. Nothing here is stubbed: verify_proof and x402_checkout
 * are free and fully functional; the paid tools (sign / seal / attest) run the real
 * x402 (HTTP 402) flow and return the on-chain settlement receipt from the server.
 */

const DEFAULT_BASE_URL = "https://fractalai.net.co";
const DEFAULT_TIMEOUT_MS = 30_000;

export function baseUrl(): string {
  return (process.env.FRACTALAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export class FractalAIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "FractalAIError";
  }
}

async function httpJson(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "fractalai-mcp-server/0.1.0",
        ...(init.headers || {}),
      },
    });
    let json: any = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return { status: res.status, json, headers: res.headers };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new FractalAIError(`Request to ${path} timed out`, 408);
    }
    throw new FractalAIError(
      `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Encode an X-PAYMENT header for the facilitator-less txHash settlement path. */
function txHashPaymentHeader(txHash: string, from?: string): string {
  const payload: Record<string, string> = { txHash };
  if (from) payload.from = from;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export interface X402Requirement {
  resource: string;
  method: string;
  price?: string;
  description?: string;
  accepts: unknown[];
  discovery?: unknown;
}

/**
 * Fetch the live x402 payment requirements for one of the paid resources.
 * This is the machine-readable HTTP 402 challenge (accepts[] + discovery schema).
 * Free — it never moves funds; it's the "what will this cost and how do I pay" call.
 */
export async function x402Requirements(
  resource: "sign" | "attest-decision" | "seal",
): Promise<X402Requirement> {
  const { status, json } = await httpJson(`/api/x402/${resource}`, {
    method: "GET",
  });
  if (status !== 402 && status !== 200) {
    throw new FractalAIError(
      `Unexpected status ${status} fetching x402 requirements for ${resource}`,
      status,
      json,
    );
  }
  return {
    resource: `${baseUrl()}/api/x402/${resource}`,
    method: "POST",
    price: json?.discovery?.price ?? json?.price,
    description: json?.discovery?.description,
    accepts: json?.accepts ?? [],
    discovery: json?.discovery,
  };
}

/** Fetch the top-level x402 manifest (.well-known/x402.json). Free. */
export async function x402Manifest(): Promise<any> {
  const { status, json } = await httpJson("/.well-known/x402.json", {
    method: "GET",
  });
  if (status !== 200) {
    throw new FractalAIError(`Manifest returned ${status}`, status, json);
  }
  return json;
}

export interface PaidCallResult {
  paid: boolean;
  /** When paid=false: the 402 challenge so the caller knows how to pay. */
  paymentRequired?: unknown;
  /** When paid=true: the resource the server returned after settling payment. */
  result?: any;
  status: number;
}

/**
 * Call a paid x402 resource.
 *
 * If `txHash` (a confirmed USDC-on-Base payment to the treasury) is supplied, we retry
 * with the X-PAYMENT header (facilitator-less txHash mode) so the server settles and
 * returns the real resource. If no payment is supplied, we return the 402 challenge
 * (accepts[]) so the caller can pay first — we do NOT fabricate a result.
 */
export async function callPaidResource(
  resource: "sign" | "attest-decision" | "seal",
  body: Record<string, unknown>,
  payment?: { txHash?: string; from?: string },
): Promise<PaidCallResult> {
  const headers: Record<string, string> = {};
  if (payment?.txHash) {
    headers["X-PAYMENT"] = txHashPaymentHeader(payment.txHash, payment.from);
  }
  const { status, json } = await httpJson(`/api/x402/${resource}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // On-chain verification of a fresh txHash can take a moment.
    timeoutMs: 45_000,
  });

  if (status === 200) {
    return { paid: true, result: json, status };
  }
  if (status === 402) {
    return { paid: false, paymentRequired: json, status };
  }
  // 400 (bad input), 409 (replayed payment), 502 (signer down), etc.
  throw new FractalAIError(
    `x402 ${resource} returned ${status}: ${json?.error || "unexpected error"}`,
    status,
    json,
  );
}

/**
 * Verify a post-quantum (ML-DSA-65 / Dilithium-3 / NIST FIPS 204) signature against a public key.
 * Free, no payment. Returns { valid, verdict }.
 *
 * `signed_message_b64` must be the base64 the signer signed. For a signature returned by
 * /api/x402/sign over a hex digest D, that is base64(utf8(D)) — the same encoding the
 * signing endpoint used internally.
 */
export async function verifyProof(params: {
  signed_message_b64: string;
  signature: string;
  public_key: string;
}): Promise<{ valid: boolean; verdict?: string }> {
  const { status, json } = await httpJson("/api/proofmind/verify", {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (status === 400) {
    throw new FractalAIError(
      json?.error || "verify_proof: missing required fields",
      400,
      json,
    );
  }
  if (status !== 200) {
    throw new FractalAIError(
      `verify_proof failed (${status})`,
      status,
      json,
    );
  }
  return { valid: Boolean(json?.valid), verdict: json?.verdict };
}
