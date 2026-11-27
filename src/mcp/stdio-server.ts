import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeClient } from '../cli-cmd/client.js';
import { createTerminalWorldMcpServer, type McpToolDeps } from './tools.js';

export interface McpStdioServerOptions {
  serverUrl?: string;
  credentialsPath?: string;
  deps?: McpToolDeps;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  fetchImpl?: typeof fetch;
}

export interface RunningMcpStdioServer {
  mcpServer: McpServer;
  transport: StdioServerTransport;
  close: () => Promise<void>;
}

/**
 * Starts the primary MCP server over stdio.
 * Only UTF-8 JSON-RPC messages are written to stdout; diagnostics go strictly to stderr.
 */
export async function startMcpStdioServer(
  options: McpStdioServerOptions = {},
): Promise<RunningMcpStdioServer> {
  const stderr = options.stderr ?? process.stderr;

  const deps: McpToolDeps = options.deps ?? {
    bridgeClient: new BridgeClient({
      baseUrl: options.serverUrl,
      credentialsPath: options.credentialsPath,
      fetchImpl: options.fetchImpl,
    }),
    credentialsPath: options.credentialsPath,
    serverUrl: options.serverUrl,
  };

  const mcpServer = createTerminalWorldMcpServer(deps);
  const transport = new StdioServerTransport(
    options.stdin ?? process.stdin,
    options.stdout ?? process.stdout,
  );

  transport.onerror = error => {
    stderr.write(`[terminal-world mcp] transport error: ${error.message}\n`);
  };

  await mcpServer.connect(transport);

  return {
    mcpServer,
    transport,
    close: async () => {
      await mcpServer.close();
    },
  };
}
