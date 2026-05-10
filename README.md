# Arete + SendAI Hybrid MCP

Single MCP server that combines:

- Arete realtime streams via `@usearete/sdk`
- SendAI on-chain actions via `solana-agent-kit` + `@solana-agent-kit/adapter-mcp`

This example is flexible by design: agents can watch any Arete view and optionally execute a SendAI action when a condition matches.

> **Note:** There is currently no official overlap between Arete and SendAI for Ore specifically. Arete publishes the Ore stack; SendAI's plugins (`plugin-defi`, `plugin-token`, `plugin-misc`) cover Jupiter, Raydium, Marginfi, Kamino, and similar protocols - but not the Ore on-chain program. To execute Ore deposits through this server, a custom tool would need to be written that calls the Ore program directly. The watch-and-execute flow works end-to-end for any protocol that SendAI already supports.

## Arete Tools

- `arete_watch_view`
  - Watch any `list` or `state` view
  - Filter/sort/select returned entities
  - Return matching entities from a realtime stream window

- `arete_watch_and_execute_sendai`
  - Same watch behavior, then execute a SendAI action
  - Safe default: `dry_run=true`

## Behavior Notes

- `mode=state` requires `key`
  - If `mode` is `state`, you must pass a non-empty `key`.
- `execute_on` controls match selection in watch-and-execute
  - `first_match`: first matching entity in stream arrival order.
  - `best_match`: uses sorted result order (when `sort_by` is provided), then selects first item.
- Numeric comparisons are strict
  - For `gt/gte/lt/lte`, both sides must be valid numeric values.
  - Non-numeric values are treated as non-matches (not silently coerced to `0`).

## Setup

```bash
npm install
cp .env.example .env
# edit .env - see "What you need and why" below
```

## Run

```bash
npm start
```

Expected startup log:

```text
Arete + SendAI MCP running...
```

## Cursor Setup

### 1. Open Cursor MCP settings

In Cursor: **Settings → MCP** (or search "MCP" in settings).

### 2. Add a new MCP server

Fill in the fields:

| Field | Value |
|-------|-------|
| Name | `arete-sendai-hybrid` |
| Command | `node` |
| Args | see below |
| Env | see below |

**Args** (two entries, in order):

```
<absolute-path-to-repo>/node_modules/tsx/dist/cli.mjs
<absolute-path-to-repo>/src/index.ts
```

Example for Windows:

```
C:/Users/you/repos/arete-sendai-hybrid-mcp/node_modules/tsx/dist/cli.mjs
C:/Users/you/repos/arete-sendai-hybrid-mcp/src/index.ts
```

### 3. Set environment variables in MCP config

Paste the values from your `.env` directly into the MCP env block. At minimum:

| Key | Value |
|-----|-------|
| `RPC_URL` | your RPC URL |
| `SOLANA_PRIVATE_KEY` | base58 or JSON array secret key |
| `ARETE_WS_URL` | `wss://ore.stack.arete.run` |
| `ARETE_STACK_NAME` | `ore` |
| `ARETE_API_KEY` | your key from [arete.run/dashboard](https://arete.run/dashboard) - required for all stacks 

### 4. JSON config (if Cursor asks for it)

```json
{
  "mcpServers": {
    "arete-sendai-hybrid": {
      "command": "node",
      "args": [
        "C:/Users/you/repos/arete-sendai-hybrid-mcp/node_modules/tsx/dist/cli.mjs",
        "C:/Users/you/repos/arete-sendai-hybrid-mcp/src/index.ts"
      ],
      "env": {
        "RPC_URL": "<your-rpc-url>",
        "SOLANA_PRIVATE_KEY": "<your-solana-private-key>",
        "ARETE_WS_URL": "wss://ore.stack.arete.run",
        "ARETE_STACK_NAME": "ore",
        "ARETE_API_KEY": "<your-arete-api-key>",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### 5. Restart and verify

1. Save MCP config and restart Cursor (or reload MCP session).
2. Open a new agent chat.
3. Ask: **"What MCP tools are available?"**
4. You should see `arete_watch_view` and `arete_watch_and_execute_sendai`.

### Node version requirement

This project requires **Node 22**. Verify with `node -v` before starting.


## What you need and why

### Minimum - read Arete data only

| Variable | Value |
|----------|-------|
| `RPC_URL` | Any Solana RPC endpoint |
| `SOLANA_PRIVATE_KEY` | Any valid keypair (can be a burner with 0 balance) |
| `ARETE_API_KEY` | Your key from [arete.run/dashboard](https://arete.run/dashboard) |
| `ARETE_WS_URL` | WebSocket URL of your stack (default: `wss://ore.stack.arete.run`) |
| `ARETE_STACK_NAME` | Stack name (default: `ore`) |

> `RPC_URL` and `SOLANA_PRIVATE_KEY` are required even for read-only use because
> `solana-agent-kit` initializes a wallet at startup. You don't need a funded wallet
> to just watch data - a freshly generated keypair is enough.

### Add this to sign transactions

| Variable | Why |
|----------|-----|
| `RPC_URL` | Must be a reliable, non-rate-limited endpoint |
| `SOLANA_PRIVATE_KEY` | The wallet that will sign and pay for transactions |

Use a dedicated low-value wallet for this. Never use your main wallet.

### Connecting to an Arete stack

| Variable | Why |
|----------|-----|
| `ARETE_API_KEY` | Required for all stacks. Get yours at [arete.run/dashboard](https://arete.run/dashboard). |
| `ARETE_WS_URL` | WebSocket URL of your stack |
| `ARETE_STACK_NAME` | Stack name |

## Example Prompts

### Read-only - check the current Ore round

> Watch the `OreRound/latest` view for 20 seconds and show me the current active round.

No wallet needed. Just streams data and returns the current round state.

### Dry-run - plan a deposit, don't sign anything

> Watch `OreRound/latest` for 20 seconds, take the active round, and show me what a 0.01 SOL deposit would look like - don't send anything to the blockchain yet.

Returns `planned_action_input` so you can verify the action before committing.

### Live - deposit into the active round

> Watch `OreRound/latest` for 20 seconds, take the active round, and deposit 0.01 SOL into it. Go ahead and sign the transaction.

Signs and broadcasts on-chain. Run the dry-run version first to confirm the action input looks right.

## Capabilities and limitations

### What this server can do

- **Watch any Arete view** (`list` or `state` mode) for up to 300 seconds
- **Filter** entities from the stream by a single field condition (`eq`, `gt`, `gte`, `lt`, `lte`, `neq`, `contains`)
- **Sort** results by any numeric or string field
- **Project** only the fields you care about (`select_fields`)
- **Execute Solana actions** from `solana-agent-kit` when a match is found - swap, stake, lend, get balance, etc.
- **Dry-run** any action first to inspect the planned input before sending

### What it cannot do (current design)

- **No autonomous background loop.** Each tool call is a single timed window (e.g. 30 seconds). The MCP server does not schedule repeating jobs or run independently between agent calls.
- **No persistent storage.** Results are returned as JSON in the tool response and exist only in the agent's context window. Nothing is written to disk or `.cursor`.
- **One filter condition per call.** You can't combine `WHERE a > 1 AND b < 2` in one call. Work around this by filtering in the agent after receiving results.
- **No multi-step conditional chains.** "Watch X, then if Y happens watch Z" requires the agent to make two sequential tool calls - the MCP tool doesn't do branching internally.

### Can I leave the agent running in a loop?

Not automatically - the MCP server is passive and only acts when called. To run something repeatedly (e.g. "for each new Ore round, do X"), you have a few options:

- **Manual loop in a Cursor agent chat**: ask the agent to call `arete_watch_view` repeatedly and reason about each result.
- **Script/cron**: write a small Node script that calls the MCP tools on a schedule via the `@modelcontextprotocol/sdk` client.
- **Future**: supports long-lived subscriptions - wrapping those into a persistent background worker alongside this MCP server is a natural next step.

## Environment Variables

Required (server will not start without these):

- `RPC_URL` - Solana RPC endpoint
- `SOLANA_PRIVATE_KEY` - Wallet keypair (base58 or JSON array)

Optional (defaults shown):

- `ARETE_WS_URL` (default: `wss://ore.stack.arete.run`)
- `ARETE_STACK_NAME` (default: `ore`)
- `ARETE_API_KEY` - required for all stacks
- `SEND_AI_ACTION_ALLOWLIST` - comma-separated action names; default exposes `trade`, `fetchprice`, `stake`, `lend`, `balance`, `wallet`
- `SKILLS_REPO_RAW_BASE_URL`
- `SKILLS_CACHE_TTL_MS` (default: `300000`)
- `MCP_SERVER_NAME` (default: `arete-sendai-hybrid`)
- `MCP_SERVER_VERSION` (default: `0.1.0`)
- `LOG_LEVEL` (default: `info`)

## Verification Checklist

1. `npm run typecheck`
2. `npm start` - expect `Arete + SendAI MCP running...` with `sendAiActions > 0`
3. Add MCP server in Cursor (see Cursor Setup above) and restart
4. In Cursor agent chat ask: "What MCP tools are available?"
5. Run `arete_watch_view` with a short `stream_seconds` (e.g. 10)
6. Run `arete_watch_and_execute_sendai` with `dry_run=true`

## Safety

- Keep `dry_run=true` until strategy logic is validated.
- Use a low-value wallet for live tx testing.
- Restrict action surface with `SEND_AI_ACTION_ALLOWLIST`.
