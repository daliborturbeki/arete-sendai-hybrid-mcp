import type { Logger, SkillBridge, SkillMetadata } from "./types.js";

interface CachedMetadata {
  expiresAt: number;
  value: SkillMetadata;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Pulls tool metadata (description/schema/examples) from a remote skills repository
 * with:
 * - in-memory TTL cache
 * - multi-path URL probing
 * - graceful fallback metadata
 */
export class HttpSkillsBridge implements SkillBridge {
  private readonly cache = new Map<string, CachedMetadata>();
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly logger: Logger;

  constructor(args: { baseUrl: string; cacheTtlMs: number; logger: Logger }) {
    this.baseUrl = args.baseUrl.replace(/\/+$/, "");
    this.cacheTtlMs = args.cacheTtlMs;
    this.logger = args.logger;
  }

  async getMetadata(toolName: string): Promise<SkillMetadata> {
    const now = Date.now();
    const hit = this.cache.get(toolName);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }

    const metadata = await this.fetchToolMetadata(toolName);
    this.cache.set(toolName, { value: metadata, expiresAt: now + this.cacheTtlMs });
    return metadata;
  }

  private async fetchToolMetadata(toolName: string): Promise<SkillMetadata> {
    const candidates = this.buildCandidateUrls(toolName);

    for (const url of candidates) {
      try {
        const payload = await this.fetchJson(url);
        const parsed = normalizeMetadata(toolName, payload, url);
        if (parsed) {
          return parsed;
        }
      } catch (error) {
        this.logger.debug("skills-bridge candidate failed", { toolName, url, error });
      }
    }

    this.logger.warn("skills-bridge fallback metadata used", { toolName });
    return fallbackMetadata(toolName, "fallback");
  }

  private buildCandidateUrls(toolName: string): string[] {
    return [
      `${this.baseUrl}/${toolName}.json`,
      `${this.baseUrl}/${toolName}/metadata.json`,
      `${this.baseUrl}/${toolName}/skill.json`,
      `${this.baseUrl}/metadata/${toolName}.json`,
      `${this.baseUrl}/skills/${toolName}.json`,
    ];
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }
}

function normalizeMetadata(
  requestedName: string,
  payload: unknown,
  source: string
): SkillMetadata | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const obj = payload as Record<string, unknown>;
  const name = asString(obj.name) ?? requestedName;
  const description =
    asString(obj.description) ??
    asString(obj.summary) ??
    `No description in remote metadata for ${requestedName}.`;

  const schema = asRecord(obj.schema) ?? asRecord(obj.input_schema);
  const examples = toExamples(obj.examples);

  return {
    name,
    description,
    schema,
    examples,
    source,
  };
}

function toExamples(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (item && typeof item === "object") {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function fallbackMetadata(toolName: string, source: string): SkillMetadata {
  return {
    name: toolName,
    description: `Fallback metadata for ${toolName}. Configure SKILLS_REPO_RAW_BASE_URL to hydrate official metadata.`,
    examples: [],
    source,
  };
}
