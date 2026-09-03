import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface McpToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

export interface SignozMcpClientOptions {
  /** The MCP server's Streamable HTTP endpoint, e.g. http://localhost:8020/mcp
   * (infra/docker-compose.yml's `signoz-mcp` service, see docs/adr/
   * 007-signoz-mcp-diagnosis.md). */
  serverUrl: string;
  /** Per-call timeout. Diagnosis must never hang the process it runs in. */
  timeoutMs?: number;
  /** Bounded retries on a failed call (each retry reconnects fresh). */
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 1;

/**
 * A thin, bounded wrapper around the official `@modelcontextprotocol/sdk`
 * client, talking to the real `signoz-mcp-server` over Streamable HTTP —
 * task.md §7.1's "an agent uses SigNoz MCP to pull the offending traces."
 * Every call is timeout-bounded and retried a fixed number of times, never
 * unboundedly — a hung or unreachable MCP server must degrade diagnosis,
 * not hang whatever called it (the breaker trip has already committed by
 * the time this runs; see docs/adr/007's "offline fallback is not
 * optional").
 */
export class SignozMcpClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private connectingClient: Client | undefined;
  private connectionGeneration = 0;

  constructor(private readonly options: SignozMcpClientOptions) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      const generation = this.connectionGeneration;
      let attemptClient: Client | undefined;
      const connection = async () => {
        const transport = new StreamableHTTPClientTransport(
          new URL(this.options.serverUrl),
        );
        const client = new Client({ name: 'fuse-diagnosis', version: '0.1.0' });
        attemptClient = client;
        this.connectingClient = client;
        // @modelcontextprotocol/sdk@1.29.0's own `Transport` interface
        // declares `sessionId: string`, but `StreamableHTTPClientTransport`
        // (the same package) actually types it `string | undefined` —
        // incompatible only under this repo's `exactOptionalPropertyTypes`
        // strictness, not a real runtime mismatch. Narrow cast, not a
        // structural workaround.
        await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
        if (generation !== this.connectionGeneration) {
          await client.close().catch(() => {});
          throw new Error('MCP connection attempt was abandoned');
        }
        this.client = client;
        return client;
      };
      const tracked = connection().finally(() => {
        if (this.connectingClient === attemptClient) this.connectingClient = undefined;
        if (this.connecting === tracked) this.connecting = undefined;
      });
      this.connecting = tracked;
    }
    return this.connecting;
  }

  /** Calls one MCP tool by name, bounded by timeout and retry count. Throws
   * (never hangs) if every attempt fails — callers (e.g. the evidence
   * fetcher) are responsible for turning that into a degraded result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          (async () => {
            const client = await this.ensureConnected();
            return client.callTool({ name, arguments: args });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`MCP tool call "${name}" timed out after ${timeoutMs}ms`),
                ),
              timeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        return result as McpToolResult;
      } catch (err) {
        lastErr = err;
        // Force a fresh connection on the next attempt — a broken
        // transport shouldn't be retried against itself.
        await this.resetConnection();
      }
    }
    throw lastErr;
  }

  async close(): Promise<void> {
    await this.resetConnection();
  }

  private async resetConnection(): Promise<void> {
    this.connectionGeneration += 1;
    const clients = new Set([this.client, this.connectingClient].filter(Boolean));
    this.client = undefined;
    this.connectingClient = undefined;
    this.connecting = undefined;
    await Promise.all(
      [...clients].map((client) => (client as Client).close().catch(() => {})),
    );
  }
}
