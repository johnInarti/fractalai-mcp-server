# FractalAI MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes
FractalAI's live **post-quantum cryptography** and **x402 micropayment** capabilities as
tools any MCP client (Claude Desktop, IDEs, agent frameworks) can call over stdio.

It talks to the real, public FractalAI deployment at `https://fractalai.net.co` — nothing
here is mocked.

## What it does

| Tool | Cost | What it does |
|------|------|--------------|
| `verify_proof` | **free** | Verify a post-quantum **ML-DSA-65 / Dilithium-3 / NIST FIPS 204** signature against its public key. Returns `{ valid, verdict }`. |
| `x402_checkout` | **free** | Return live [x402](https://x402.org) (HTTP 402) payment requirements for a paid resource — price, network, USDC asset, `payTo`, and the `accepts[]` entries. Also fetches the full `.well-known/x402.json` manifest. |
| `pqc_sign` | **$0.02 USDC** | Buy one ML-DSA-65 / Dilithium-3 signature over a `message` (its sha256 is signed) or a hex `hash` (signed directly). |
| `seal_provenance` | **$0.05 USDC** | Buy a PQC + [drand](https://drand.love) provenance seal over content: a drand round + a self-contained ML-DSA-65 / Dilithium-3 signature + an on-chain anchor attempt (this server's node-bound Dilithium-2 key) over the content hash. |
| `attest_decision` | **$0.05 USDC** | Seal an AI agent's declared decision (input hash, output, model, timestamp) — chained in an append-only Black Box, anchored on-chain (VAID-1, node-bound Dilithium-2 key), and returned with a self-contained ML-DSA-65 / Dilithium-3 signature for independent offline verification. |

## Honest scope (read this)

- **The signature every tool here serves/verifies directly is ML-DSA-65 / Dilithium-3 (NIST
  FIPS-204, Cat-3).** `seal_provenance` and `attest_decision` ALSO write a separate on-chain
  anchor (VAID-1) using this server's node-bound Dilithium-2 key — additive, not the signature
  returned to you.
- **Dilithium-3 is resistant to known classical and quantum attacks per NIST FIPS 204 — it is
  NOT "unbreakable".** A signature proves the *exact bytes* you submitted were signed by this
  server's post-quantum key. It says **nothing** about the truthfulness of the signed content.
- `seal_provenance` produces a **provenance record**, not a content audit.
- `attest_decision` **notarizes a decision as declared**; it does not judge whether the decision
  was correct.
- The paid tools run a **real HTTP 402 flow**. Without a `payment_tx_hash` they return the
  payment *challenge* (`accepts[]`) — they never fabricate a result.

## Payment model (x402)

Paid tools are gated by [x402](https://x402.org): pay in **USDC on Base** to the service's
treasury, then the tool returns the resource. This server uses the **facilitator-less txHash**
settlement path, which needs no facilitator account:

1. Call the tool once with no `payment_tx_hash`. You get back the `accepts[]` block: the exact
   USDC amount, the `asset` (USDC on Base), and the `payTo` treasury address.
2. Send that USDC transfer on Base yourself.
3. Call the tool again with `payment_tx_hash` set to the confirmed transaction hash. One
   txHash buys exactly one call (anti-replay is enforced server-side).

`verify_proof` and `x402_checkout` are always free.

## Install & build

```bash
cd integrations/mcp
npm install
npm run build
```

## Configure in an MCP client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "fractalai": {
      "command": "node",
      "args": ["/absolute/path/to/integrations/mcp/dist/index.js"]
    }
  }
}
```

### Any stdio MCP client

Run the built entrypoint: `node dist/index.js`. It speaks MCP over stdio; all logging goes to
stderr so stdout stays a clean JSON-RPC channel.

### Environment

- `FRACTALAI_BASE_URL` — override the endpoint base (defaults to `https://fractalai.net.co`).

## Example flows

**Verify a signature (free):**
```json
{
  "name": "verify_proof",
  "arguments": {
    "signed_message_b64": "<base64 of the exact bytes that were signed>",
    "signature": "<base64 ML-DSA-65 / Dilithium-3 signature>",
    "public_key": "<base64 ML-DSA-65 / Dilithium-3 public key>"
  }
}
```

**Price a signature (free), then buy it (paid):**
```json
{ "name": "x402_checkout", "arguments": { "resource": "sign" } }
```
```json
{ "name": "pqc_sign", "arguments": { "message": "hello world" } }
```
The first `pqc_sign` call (no `payment_tx_hash`) returns the payment challenge. Pay the USDC,
then call again:
```json
{
  "name": "pqc_sign",
  "arguments": { "message": "hello world", "payment_tx_hash": "0x…" }
}
```

## About FractalAI

FractalAI is an AI-native Layer 1 blockchain (chain id 62124) written in Rust with
post-quantum cryptography (ML-DSA-65 / Dilithium-3 signatures, Kyber encryption). These x402
endpoints sell post-quantum proof, provenance and decision-attestation services to autonomous
agents. See `https://fractalai.net.co` and the discovery manifest at
`https://fractalai.net.co/.well-known/x402.json`.

## License

MIT
