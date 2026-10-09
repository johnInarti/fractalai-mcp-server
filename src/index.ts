#!/usr/bin/env node
/**
 * FractalAI MCP server.
 *
 * Exposes FractalAI's live post-quantum + x402 payment capabilities as Model Context
 * Protocol tools over stdio, so any MCP-compatible client (Claude Desktop, IDEs, agent
 * frameworks) can call them.
 *
 * Tools:
 *   - verify_proof        (free)  verify an ML-DSA-65 / Dilithium-3 / NIST FIPS 204 signature
 *   - x402_checkout       (free)  live payment requirements for a paid resource
 *   - pqc_sign            (paid)  buy one post-quantum signature over a message/hash
 *   - seal_provenance     (paid)  drand-timestamped PQC provenance seal over content
 *   - attest_decision     (paid)  seal an AI agent's declared decision (VAID-1 receipt)
 *
 * Honesty (per project Regla 4): the signature every tool here serves/verifies directly is
 * ML-DSA-65 / Dilithium-3 (NIST FIPS-204, Cat-3). seal_provenance and attest_decision ALSO
 * write a separate on-chain anchor (VAID-1) using this server's node-bound Dilithium-2 key —
 * additive, not the signature returned to you. Dilithium-3 is resistant to known classical and
 * quantum attacks per NIST FIPS 204 — it is NOT "unbreakable". A signature proves the exact
 * bytes were signed by this server's key; it says nothing about their truthfulness. The paid
 * tools run a real HTTP 402 flow: without a payment they return the payment challenge, they
 * never fabricate a result.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  baseUrl,
  x402Requirements,
  x402Manifest,
  callPaidResource,
  verifyProof,
  FractalAIError,
} from "./fractalai.js";

const server = new McpServer({
  name: "fractalai",
  version: "0.1.1",
});

/** Wrap a handler so thrown errors become MCP tool errors instead of crashing the process. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string, extra?: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, ...(extra ? { detail: extra } : {}) }, null, 2),
      },
    ],
  };
}

// ── verify_proof (free) ──────────────────────────────────────────────────────
server.registerTool(
  "verify_proof",
  {
    title: "Verify a post-quantum signature",
    description:
      "Verify a post-quantum (ML-DSA-65 / Dilithium-3, NIST FIPS 204) signature against its public " +
      "key. Free, no payment. Returns { valid, verdict }. A valid result proves the exact bytes in " +
      "signed_message_b64 were signed by the given key; it says nothing about their truthfulness. " +
      "For a signature from pqc_sign over a hex digest D, signed_message_b64 = base64(utf8(D)).",
    inputSchema: {
      signed_message_b64: z
        .string()
        .describe("Base64 of the exact bytes that were signed."),
      signature: z.string().describe("Base64 ML-DSA-65 / Dilithium-3 signature to check."),
      public_key: z.string().describe("Base64 ML-DSA-65 / Dilithium-3 public key."),
    },
  },
  async (args) => {
    try {
      const res = await verifyProof(args);
      return ok(res);
    } catch (e) {
      return fail(
        e instanceof FractalAIError ? e.message : String(e),
        e instanceof FractalAIError ? e.body : undefined,
      );
    }
  },
);

// ── x402_checkout (free) ─────────────────────────────────────────────────────
server.registerTool(
  "x402_checkout",
  {
    title: "Get x402 payment requirements",
    description:
      "Return the live x402 (HTTP 402) payment requirements for a paid FractalAI resource: " +
      "price, network, USDC asset, payTo address and the accepts[] entries (EIP-3009 gasless " +
      "and txHash fallback). Free — it never moves funds. Use it before pqc_sign / seal_provenance " +
      "/ attest_decision to learn exactly how much and how to pay. Pass resource='manifest' for the " +
      "full .well-known/x402.json.",
    inputSchema: {
      resource: z
        .enum(["sign", "attest-decision", "seal", "manifest"])
        .describe("Which paid resource to price, or 'manifest' for the whole x402 manifest."),
    },
  },
  async ({ resource }) => {
    try {
      if (resource === "manifest") {
        return ok(await x402Manifest());
      }
      return ok(await x402Requirements(resource));
    } catch (e) {
      return fail(
        e instanceof FractalAIError ? e.message : String(e),
        e instanceof FractalAIError ? e.body : undefined,
      );
    }
  },
);

// Shared payment input for the paid tools (facilitator-less txHash settlement).
const paymentShape = {
  payment_tx_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .describe(
      "A confirmed USDC-on-Base transaction hash paying the required amount to the treasury. " +
        "If omitted, the tool returns the x402 payment challenge (accepts[]) instead of a result — " +
        "pay first, then call again with this set. One txHash buys exactly one call.",
    ),
  payer: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional()
    .describe("Optional payer address hint."),
};

async function runPaid(
  resource: "sign" | "attest-decision" | "seal",
  body: Record<string, unknown>,
  payment_tx_hash?: string,
  payer?: string,
) {
  try {
    const res = await callPaidResource(resource, body, {
      txHash: payment_tx_hash,
      from: payer,
    });
    if (res.paid) return ok({ paid: true, result: res.result });
    return ok({
      paid: false,
      note:
        "Payment required. Pay the amount in `paymentRequired.accepts` (USDC on Base to payTo), " +
        "then call again with payment_tx_hash set to the confirmed transaction hash.",
      paymentRequired: res.paymentRequired,
    });
  } catch (e) {
    return fail(
      e instanceof FractalAIError ? e.message : String(e),
      e instanceof FractalAIError ? e.body : undefined,
    );
  }
}

// ── pqc_sign (paid, $0.02) ───────────────────────────────────────────────────
server.registerTool(
  "pqc_sign",
  {
    title: "Buy a post-quantum signature",
    description:
      "Pay $0.02 USDC (x402) for one post-quantum ML-DSA-65 / Dilithium-3 (NIST FIPS 204) signature " +
      "over your message (its sha256 is signed) or a hex hash (signed directly). Returns { digest, signature, " +
      "public_key, payment }. Without payment_tx_hash you get the payment challenge, not a signature. " +
      "The signature proves these exact bytes were signed by this server's PQC key — nothing about " +
      "their truthfulness, and 'quantum-resistant per NIST' is not 'unbreakable'.",
    inputSchema: {
      message: z.string().optional().describe("UTF-8 string; sha256(message) is signed."),
      hash: z.string().optional().describe("Hex digest signed directly. Provide message OR hash."),
      ...paymentShape,
    },
  },
  async ({ message, hash, payment_tx_hash, payer }) => {
    if (!message && !hash) {
      return fail("Provide `message` (UTF-8, its sha256 is signed) or `hash` (hex, signed directly).");
    }
    const body: Record<string, unknown> = {};
    if (message) body.message = message;
    if (hash) body.hash = hash;
    return runPaid("sign", body, payment_tx_hash, payer);
  },
);

// ── seal_provenance (paid, $0.05) ────────────────────────────────────────────
server.registerTool(
  "seal_provenance",
  {
    title: "Buy a PQC + drand provenance seal",
    description:
      "Pay $0.05 USDC (x402) for a post-quantum provenance seal over content: a drand round (League " +
      "of Entropy, not backdateable) + a self-contained ML-DSA-65 / Dilithium-3 signature over the " +
      "seal + an on-chain anchor attempt (this server's node-bound Dilithium-2 key) over the content " +
      "hash. Useful for EU AI Act (Art. 10/50/53) provenance. It is a provenance record, not a " +
      "content audit. Without payment_tx_hash you get the payment challenge.",
    inputSchema: {
      content: z.string().optional().describe("UTF-8 content; sha256(content) is sealed."),
      content_hash: z.string().optional().describe("Sha256 hex you already computed. Provide content OR content_hash."),
      ...paymentShape,
    },
  },
  async ({ content, content_hash, payment_tx_hash, payer }) => {
    if (!content && !content_hash) {
      return fail("Provide `content` (UTF-8) or `content_hash` (sha256 hex).");
    }
    const body: Record<string, unknown> = {};
    if (content) body.content = content;
    if (content_hash) body.content_hash = content_hash;
    return runPaid("seal", body, payment_tx_hash, payer);
  },
);

// ── attest_decision (paid, $0.05) ────────────────────────────────────────────
server.registerTool(
  "attest_decision",
  {
    title: "Seal an AI agent decision (VAID-1)",
    description:
      "Pay $0.05 USDC (x402) to seal an AI agent's declared decision: its input hash, output, model and " +
      "timestamp are chained in an append-only Black Box and anchored on-chain (VAID-1, this server's " +
      "node-bound Dilithium-2 key). You also get back a self-contained ML-DSA-65 / Dilithium-3 signature " +
      "over the same canonical decision bytes for independent offline verification. Returns a " +
      "re-verifiable receipt. Built for EU AI Act Art.12 record-keeping. It notarizes the decision as " +
      "declared; it does not judge whether the decision was correct. Without payment_tx_hash you get the " +
      "payment challenge.",
    inputSchema: {
      agent_id: z.string().describe("Stable identifier of the agent whose decision is sealed."),
      input: z.string().describe("The decision input (or its hash)."),
      output: z.string().describe("The decision output the agent produced."),
      model: z.string().optional().describe("Model/agent version that produced the decision."),
      ...paymentShape,
    },
  },
  async ({ agent_id, input, output, model, payment_tx_hash, payer }) => {
    const body: Record<string, unknown> = { agent_id, input, output };
    if (model) body.model = model;
    return runPaid("attest-decision", body, payment_tx_hash, payer);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP JSON-RPC channel and must stay clean.
  process.stderr.write(
    `fractalai-mcp-server connected (stdio). Endpoints: ${baseUrl()}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`fractalai-mcp-server fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
