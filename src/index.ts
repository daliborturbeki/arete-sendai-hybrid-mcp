import "dotenv/config";
import { createMcpServer } from "@solana-agent-kit/adapter-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { KeypairWallet, SolanaAgentKit } from "solana-agent-kit";
import { HttpSkillsBridge } from "./skills-bridge.js";
import { registerAreteTools, type HybridAreteRuntime } from "./tools.js";
import type { AppConfig, LogLevel, Logger } from "./types.js";

/**
 * Entry point for the hybrid server:
 * 1) load config/env
 * 2) initialize wallet + SendAI actions
 * 3) create MCP server from SendAI actions
 * 4) attach custom Arete tools onto the same server
 * 5) connect stdio transport
 */
export async function startHybridMcp() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const skillBridge = new HttpSkillsBridge({
    baseUrl: config.skillsRepoRawBaseUrl,
    cacheTtlMs: config.skillsCacheTtlMs,
    logger,
  });

  const keypair = parseKeypair(config.solanaPrivateKey);
  const wallet = new KeypairWallet(keypair, config.rpcUrl);
  const TokenPlugin = await loadPlugin("@solana-agent-kit/plugin-token");
  const DefiPlugin = await loadPlugin("@solana-agent-kit/plugin-defi");
  const MiscPlugin = await loadPlugin("@solana-agent-kit/plugin-misc");

  // NOTE: plugins currently carry slightly divergent type packages, so we keep casts here.
  let agent = new SolanaAgentKit(wallet, config.rpcUrl, {}) as any;
  if (TokenPlugin) {
    agent = agent.use(TokenPlugin as any);
  }
  if (DefiPlugin) {
    agent = agent.use(DefiPlugin as any);
  }
  if (MiscPlugin) {
    agent = agent.use(MiscPlugin as any);
  }

  const selectedActions = pickActions(agent.actions as any[], config.sendAiActionAllowlist, logger);
  const server = createMcpServer(selectedActions as any, agent as any, {
    name: config.mcpServerName,
    version: config.mcpServerVersion,
  });

  const areteRuntime = registerAreteTools({
    server,
    config,
    logger,
    skillBridge,
    actions: selectedActions as any,
    agent: agent as any,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Arete + SendAI MCP running...", {
    areteWsUrl: config.areteWsUrl,
    stack: config.areteStackName,
    sendAiActions: Object.keys(selectedActions).length,
  });

  setupShutdownHandlers(server, areteRuntime, logger);

  return { server, areteRuntime };
}

async function loadPlugin(moduleName: string): Promise<any | null> {
  try {
    const mod = await import(moduleName);
    return mod.default ?? null;
  } catch (error) {
    void error;
    return null;
  }
}

function setupShutdownHandlers(
  server: { close(): Promise<void> },
  areteRuntime: HybridAreteRuntime,
  logger: Logger
) {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down MCP server`);
    try {
      await areteRuntime.disconnect();
    } catch (error) {
      logger.warn("Failed to disconnect Arete runtime", error);
    }
    try {
      await server.close();
    } catch (error) {
      logger.warn("Failed to close MCP server cleanly", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function pickActions(actions: any[], allowlist: string[], logger: Logger): Record<string, any> {
  const byName = new Map(actions.map((action) => [action.name, action]));
  const selected = new Map<string, any>();

  if (allowlist.length > 0) {
    for (const requested of allowlist) {
      const action = findAction(actions, requested);
      if (action) {
        selected.set(action.name, action);
      } else {
        logger.warn("allowlisted SendAI action not found", { requested });
      }
    }
  } else {
    const defaults = [
      "trade",
      "fetchprice",
      "stake",
      "lend",
      "deposit",
      "balance",
      "wallet",
      "address",
    ];
    for (const action of actions) {
      const key = action.name.toLowerCase();
      if (defaults.some((needle) => key.includes(needle))) {
        selected.set(action.name, action);
      }
    }
  }

  if (selected.size === 0) {
    logger.warn("No action filters matched; exposing all SendAI actions");
    for (const [name, action] of byName.entries()) {
      selected.set(name, action);
    }
  }

  logger.info("Selected SendAI actions", {
    selected: [...selected.keys()].slice(0, 40),
    total: selected.size,
    available: actions.length,
  });

  return Object.fromEntries(selected.entries());
}

function findAction(actions: any[], requested: string): any | undefined {
  const needle = requested.trim().toLowerCase();
  return actions.find((action) => {
    const name = action.name.toLowerCase();
    return name === needle || name.includes(needle);
  });
}

function parseKeypair(secret: string): Keypair {
  const trimmed = secret.trim();

  try {
    if (trimmed.startsWith("[")) {
      const array = JSON.parse(trimmed) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(array));
    }

    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch (error) {
    throw new Error(
      "Invalid SOLANA_PRIVATE_KEY format. Use a base58-encoded secret key or a JSON array (e.g. [12,34,...]).",
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

function loadConfig(): AppConfig {
  // Public default endpoint makes local testing easy out of the box
  const areteWsUrl = process.env.ARETE_WS_URL ?? "wss://ore.stack.arete.run";
  const rpcUrl = required("RPC_URL");
  const solanaPrivateKey = required("SOLANA_PRIVATE_KEY");

  return {
    areteWsUrl,
    areteStackName: process.env.ARETE_STACK_NAME ?? "ore",
    areteApiKey: process.env.ARETE_API_KEY,
    skillsRepoRawBaseUrl:
      process.env.SKILLS_REPO_RAW_BASE_URL ?? "https://raw.githubusercontent.com/AreteA4/skills/main/metadata",
    skillsCacheTtlMs: parsePositiveInt(process.env.SKILLS_CACHE_TTL_MS, 300_000),
    rpcUrl,
    solanaPrivateKey,
    sendAiActionAllowlist: csv(process.env.SEND_AI_ACTION_ALLOWLIST),
    mcpServerName: process.env.MCP_SERVER_NAME ?? "arete-sendai-hybrid",
    mcpServerVersion: process.env.MCP_SERVER_VERSION ?? "0.1.0",
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const candidate = (value ?? "info").toLowerCase();
  if (candidate === "debug" || candidate === "info" || candidate === "warn" || candidate === "error") {
    return candidate;
  }
  return "info";
}

function createLogger(level: LogLevel): Logger {
  const rank: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };

  const threshold = rank[level];

  const emit = (severity: LogLevel, message: string, details?: unknown) => {
    if (rank[severity] < threshold) return;

    const line = `[${new Date().toISOString()}] [${severity.toUpperCase()}] ${message}`;
    if (severity === "error") {
      console.error(line);
    } else if (severity === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    if (details !== undefined) {
      console.log(JSON.stringify(details, null, 2));
    }
  };

  return {
    debug: (message, details) => emit("debug", message, details),
    info: (message, details) => emit("info", message, details),
    warn: (message, details) => emit("warn", message, details),
    error: (message, details) => emit("error", message, details),
  };
}

startHybridMcp().catch((error) => {
  console.error("Fatal: Failed to start hybrid MCP server");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
