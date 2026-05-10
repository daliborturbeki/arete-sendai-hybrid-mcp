import type { Action } from "solana-agent-kit";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  areteWsUrl: string;
  areteStackName: string;
  areteApiKey?: string;
  skillsRepoRawBaseUrl: string;
  skillsCacheTtlMs: number;
  rpcUrl: string;
  solanaPrivateKey: string;
  sendAiActionAllowlist: string[];
  mcpServerName: string;
  mcpServerVersion: string;
  logLevel: LogLevel;
}

export interface SkillMetadata {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  examples: Array<Record<string, unknown>>;
  source?: string;
}

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface SkillBridge {
  getMetadata(toolName: string): Promise<SkillMetadata>;
}

export interface ToolContext {
  config: AppConfig;
  logger: Logger;
  skillBridge: SkillBridge;
}

export interface HybridServerContext extends ToolContext {
  actions: Record<string, Action>;
}

export interface ToolResultPayload<TItem> {
  tool: string;
  view: string;
  matches: number;
  stream_seconds: number;
  generated_at: string;
  skill_metadata: SkillMetadata;
  items: TItem[];
}
