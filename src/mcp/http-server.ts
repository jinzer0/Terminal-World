import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createTerminalWorldMcpServer, type McpToolDeps } from './tools.js';

export interface McpHttpServerOptions {
  host?: string;
  port?: number;
  path?: string;
  deps: McpToolDeps;
  onError?: (error: unknown) => void;
}

export interface RunningMcpHttpServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  activeSessions: () => number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('Request body exceeds 1MB limit');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  if (res.writableEnded) return;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

/**
 * Optional MCP 2025-11-25 Streamable HTTP endpoint (`--mcp-http`), sharing `src/mcp/tools.ts`.
 */
export async function startMcpHttpServer(
  options: McpHttpServerOptions,
): Promise<RunningMcpHttpServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 4311;
  const endpointPath = options.path ?? '/mcp';

  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${requestedPort}`}`);
    if (url.pathname !== endpointPath) {
      writeJsonRpcError(res, 404, -32001, `Unknown MCP path: ${url.pathname}`);
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;

    if (method === 'POST') {
      let parsedBody: unknown;
      try {
        parsedBody = await readJsonBody(req);
      } catch (err) {
        writeJsonRpcError(
          res,
          400,
          -32700,
          err instanceof Error ? err.message : 'Invalid JSON-RPC payload',
        );
        return;
      }

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          writeJsonRpcError(res, 404, -32001, 'MCP session not found');
          return;
        }
        await existing.transport.handleRequest(req, res, parsedBody);
        return;
      }

      const isInit = isInitializeRequest(parsedBody)
        || (Array.isArray(parsedBody) && parsedBody.some(msg => isInitializeRequest(msg)));
      if (!isInit) {
        writeJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header or initialize request required');
        return;
      }

      const mcpServer = createTerminalWorldMcpServer(options.deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: newSessionId => {
          sessions.set(newSessionId, { server: mcpServer, transport });
        },
        onsessionclosed: closedSessionId => {
          sessions.delete(closedSessionId);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
        void mcpServer.close().catch(() => {});
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (method === 'GET' || method === 'DELETE') {
      if (!sessionId) {
        writeJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header required');
        return;
      }
      const existing = sessions.get(sessionId);
      if (!existing) {
        writeJsonRpcError(res, 404, -32001, 'MCP session not found');
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    writeJsonRpcError(res, 405, -32601, `Method not allowed: ${method}`);
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(error => {
      options.onError?.(error);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, error instanceof Error ? error.message : 'Internal server error');
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
  const mcpUrl = `http://${host}:${actualPort}${endpointPath}`;

  return {
    server,
    host,
    port: actualPort,
    url: mcpUrl,
    activeSessions: () => sessions.size,
    close: async () => {
      for (const { transport, server: mcpServer } of Array.from(sessions.values())) {
        try {
          await transport.close();
        } catch {
          // ignore
        }
        try {
          await mcpServer.close();
        } catch {
          // ignore
        }
      }
      sessions.clear();
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    },
  };
}
