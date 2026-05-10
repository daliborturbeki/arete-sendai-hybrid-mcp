import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Arete,
  type AuthConfig,
  type RichUpdate,
  type StackDefinition,
  type TypedListView,
  type TypedStateView,
} from "@usearete/sdk";
import type { Action } from "solana-agent-kit";
import { z } from "zod";
import type { AppConfig, Logger, SkillBridge, ToolResultPayload } from "./types.js";

const WatchInputSchema = z.object({
  view: z.string().min(1),
  mode: z.enum(["list", "state"]).default("list"),
  key: z.string().optional(),
  ws_url: z.string().url().optional(),
  stack_name: z.string().optional(),
  filters: z.record(z.string()).optional(),
  take: z.number().int().positive().max(500).default(50),
  stream_seconds: z.number().int().positive().max(300).default(30),
  where_field: z.string().optional(),
  where_op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]).optional(),
  where_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  sort_by: z.string().optional(),
  sort_order: z.enum(["asc", "desc"]).default("desc"),
  select_fields: z.array(z.string()).optional(),
});

/**
 * Watch-and-execute extends watch input with action details.
 * `execute_on` controls selection strategy:
 * - first_match: stream-order first entity
 * - best_match: sorted best entity (if sort_by provided, define take or stream_seconds)
 */
const WatchAndActSchema = WatchInputSchema.extend({
  action_name: z.string().min(1),
  action_input: z.record(z.any()).default({}),
  dry_run: z.boolean().default(true),
  execute_on: z.enum(["first_match", "best_match"]).default("best_match"),
});

interface RegisterToolArgs {
  server: McpServer;
  config: AppConfig;
  logger: Logger;
  skillBridge: SkillBridge;
  actions: Record<string, Action>;
  agent: unknown;
}

export interface HybridAreteRuntime {
  disconnect(): Promise<void>;
}

interface WatchInput {
  view: string;
  mode?: "list" | "state";
  key?: string;
  ws_url?: string;
  stack_name?: string;
  filters?: Record<string, string>;
  take?: number;
  stream_seconds?: number;
  where_field?: string;
  where_op?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
  where_value?: string | number | boolean;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  select_fields?: string[];
}

interface WatchAndActInput extends WatchInput {
  action_name: string;
  action_input?: Record<string, unknown>;
  dry_run?: boolean;
  execute_on?: "first_match" | "best_match";
}

interface WatchResult {
  items: Record<string, unknown>[];
  view: string;
  streamSeconds: number;
}

/**
 * Registers custom Arete tools onto the already-created SendAI MCP server
 */
export function registerAreteTools(args: RegisterToolArgs): HybridAreteRuntime {
  const runtime = new AreteRuntime(args);

  args.server.tool(
    "arete_watch_view",
    "Watch any Arete view (list/state), filter/sort stream updates, and return matching entities.",
    WatchInputSchema.shape,
    async (input: WatchInput) => runtime.handleWatch(input)
  );

  args.server.tool(
    "arete_watch_and_execute_sendai",
    "Watch any Arete view and execute a SendAI action when a match is found (or dry-run plan).",
    WatchAndActSchema.shape,
    async (input: WatchAndActInput) => runtime.handleWatchAndExecute(input)
  );

  return {
    disconnect: async () => undefined,
  };
}

class AreteRuntime {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly skillBridge: SkillBridge;
  private readonly actions: Record<string, Action>;
  private readonly agent: unknown;

  constructor(args: RegisterToolArgs) {
    this.config = args.config;
    this.logger = args.logger;
    this.skillBridge = args.skillBridge;
    this.actions = args.actions;
    this.agent = args.agent;
  }

  async handleWatch(input: WatchInput) {
    const watch = await this.collectMatches(input, { sortResults: true });
    const skillMetadata = await this.skillBridge.getMetadata("arete_watch_view");

    const payload: ToolResultPayload<Record<string, unknown>> = {
      tool: "arete_watch_view",
      view: watch.view,
      matches: watch.items.length,
      stream_seconds: watch.streamSeconds,
      generated_at: new Date().toISOString(),
      skill_metadata: skillMetadata,
      items: watch.items,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    };
  }

  async handleWatchAndExecute(input: WatchAndActInput) {
    const executeOn = input.execute_on ?? "best_match";
    const sortResults = executeOn === "best_match";

    if (executeOn === "first_match" && input.sort_by) {
      this.logger.warn("execute_on=first_match ignores sort_by; using stream arrival order", {
        sort_by: input.sort_by,
      });
    }

    const watch = await this.collectMatches(input, { sortResults });
    const skillMetadata = await this.skillBridge.getMetadata("arete_watch_and_execute_sendai");
    const action = this.resolveAction(input.action_name);
    const selected = watch.items[0];

    if (!selected) {
      const emptyPayload = {
        tool: "arete_watch_and_execute_sendai",
        view: watch.view,
        matches: 0,
        stream_seconds: watch.streamSeconds,
        generated_at: new Date().toISOString(),
        skill_metadata: skillMetadata,
        action: action?.name ?? input.action_name,
        executed: false,
        reason: "No matching entities in stream window",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(emptyPayload, null, 2) }],
      };
    }

    if (!action) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Action '${input.action_name}' not found in exposed SendAI actions.`,
          },
        ],
      };
    }

    const actionInput = {
      ...(input.action_input ?? {}),
      arete_match: selected,
      arete_view: watch.view,
    };

    const dryRun = input.dry_run ?? true;
    if (dryRun) {
      const dryPayload = {
        tool: "arete_watch_and_execute_sendai",
        view: watch.view,
        matches: watch.items.length,
        stream_seconds: watch.streamSeconds,
        generated_at: new Date().toISOString(),
        skill_metadata: skillMetadata,
        action: action.name,
        execute_on: executeOn,
        executed: false,
        dry_run: true,
        selected_match: selected,
        planned_action_input: actionInput,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(dryPayload, null, 2) }],
      };
    }

    this.logger.warn("Executing SendAI action from watch-and-execute tool", {
      action: action.name,
      view: watch.view,
      execute_on: executeOn,
    });

    try {
      const result = await action.handler(this.agent as any, actionInput);
      const execPayload = {
        tool: "arete_watch_and_execute_sendai",
        view: watch.view,
        matches: watch.items.length,
        stream_seconds: watch.streamSeconds,
        generated_at: new Date().toISOString(),
        skill_metadata: skillMetadata,
        action: action.name,
        execute_on: executeOn,
        executed: true,
        dry_run: false,
        selected_match: selected,
        action_result: result,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(execPayload, null, 2) }],
      };
    } catch (error) {
      this.logger.error("SendAI action execution failed", error);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : "Unknown action execution error",
          },
        ],
      };
    }
  }

  private resolveAction(requested: string): Action | undefined {
    const needle = requested.trim().toLowerCase();
    const exact = this.actions[requested];
    if (exact) return exact;
    return Object.values(this.actions).find((action) => {
      const name = action.name.toLowerCase();
      return name === needle || name.includes(needle);
    });
  }

  /**
   * Core data pipeline:
   * 1) Build a tiny one-view stack dynamically
   * 2) Connect to Arete
   * 3) Collect streaming updates within time and count bounds
   * 4) Apply filtering / sorting / projection
   */
  private async collectMatches(input: WatchInput,options: { sortResults: boolean }): Promise<WatchResult> {
    const streamSeconds = input.stream_seconds ?? 30;
    const take = input.take ?? 50;
    const mode = input.mode ?? "list";
    const view = input.view;

    if (mode === "state" && (!input.key || input.key.trim().length === 0)) {
      throw new Error("State mode requires a non-empty 'key'");
    }

    const targetViewGroup =
      mode === "state"
        ? {
            state: {
              mode: "state" as const,
              view,
            },
          }
        : {
            list: {
              mode: "list" as const,
              view,
            },
          };

    const wsUrl = input.ws_url ?? this.config.areteWsUrl;
    const stack: StackDefinition = {
      name: input.stack_name ?? this.config.areteStackName,
      url: wsUrl,
      views: {
        target: targetViewGroup,
      },
    };

    const auth = this.buildAreteAuth();

    const client = await Arete.connect(stack, { auth, autoReconnect: true });
    try {
      let stream: AsyncIterable<RichUpdate<unknown>>;
      if (mode === "state") {
        const stateView = client.views.target.state as TypedStateView<unknown> | undefined;
        if (!stateView) {
          throw new Error(`View '${view}' is not available in state mode`);
        }
        stream = stateView.watchRich(input.key!, {
          withSnapshot: false,
          filters: input.filters,
        });
      } else {
        const listView = client.views.target.list as TypedListView<unknown> | undefined;
        if (!listView) {
          throw new Error(`View '${view}' is not available in list mode`);
        }
        stream = listView.watchRich({
          withSnapshot: false,
          filters: input.filters,
        });
      }

      const items = await collectFromRichStream(stream, {
        maxItems: take,
        streamSeconds,
        map: entityFromUpdate,
        predicate: (entity) => this.matchesWhere(entity, input),
      });

      if (options.sortResults && input.sort_by) {
        const order = input.sort_order ?? "desc";
        items.sort((a, b) => compareByPath(a, b, input.sort_by!, order));
      }

      const projected = input.select_fields?.length
        ? items.map((item) => projectFields(item, input.select_fields ?? []))
        : items;

      return {
        items: projected,
        view,
        streamSeconds,
      };
    } finally {
      client.disconnect();
    }
  }

  private buildAreteAuth(): AuthConfig | undefined {
    const key = this.config.areteApiKey?.trim();
    if (key) {
      return { publishableKey: key };
    }
    return undefined;
  }

  private matchesWhere(entity: Record<string, unknown>, input: WatchInput): boolean {
    const field = input.where_field;
    const op = input.where_op;
    const value = input.where_value;
    if (!field || !op || value === undefined) return true;

    const actual = readPath(entity, field);
    switch (op) {
      case "eq":
        return actual === value;
      case "neq":
        return actual !== value;
      case "contains":
        return typeof actual === "string" && actual.toLowerCase().includes(String(value).toLowerCase());
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const actualNum = tryParseNumber(actual);
        const targetNum = tryParseNumber(value);
        if (actualNum === null || targetNum === null) return false;
        if (op === "gt") return actualNum > targetNum;
        if (op === "gte") return actualNum >= targetNum;
        if (op === "lt") return actualNum < targetNum;
        return actualNum <= targetNum;
      }
      default:
        return true;
    }
  }
}

async function collectFromRichStream(
  stream: AsyncIterable<RichUpdate<unknown>>,
  args: {
    maxItems: number;
    streamSeconds: number;
    map: (value: RichUpdate<unknown>) => Record<string, unknown> | null;
    predicate: (value: Record<string, unknown>) => boolean;
  }
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  const deadline = Date.now() + args.streamSeconds * 1_000;
  const iterator = stream[Symbol.asyncIterator]();

  try {
    while (items.length < args.maxItems) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const next = await nextWithTimeout(iterator, remaining);
      if (!next || next.done) break;

      const mapped = args.map(next.value);
      if (!mapped) continue;
      if (!args.predicate(mapped)) continue;
      items.push(mapped);
    }
  } finally {
    if (iterator.return) {
      await iterator.return();
    }
  }

  return items;
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number
): Promise<IteratorResult<T> | null> {
  return Promise.race([iterator.next(), sleep(timeoutMs).then(() => null)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function entityFromUpdate(update: RichUpdate<unknown>): Record<string, unknown> | null {
  if (update.type === "deleted") return null;
  const entity = asRecord(update.type === "created" ? update.data : update.after);
  if (!entity) return null;
  return {
    key: update.key,
    ...entity,
  };
}

function compareByPath(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path: string,
  order: "asc" | "desc"
): number {
  const av = readPath(a, path);
  const bv = readPath(b, path);
  const direction = order === "asc" ? 1 : -1;
  const an = tryParseNumber(av);
  const bn = tryParseNumber(bv);

  if (an !== null && bn !== null) {
    return (an - bn) * direction;
  }

  const as = String(av ?? "");
  const bs = String(bv ?? "");
  if (as < bs) return -1 * direction;
  if (as > bs) return 1 * direction;
  return 0;
}

function projectFields(item: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field] = readPath(item, field);
  }
  out.key = item.key;
  return out;
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function tryParseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
