import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { defaultMockModel } from './mock-model.js';
import type { Model, ModelCallArgs, ModelCallResult } from './types.js';

export interface RequestCountingModelServer {
  model: Model;
  requestCount: () => number;
  close: () => Promise<void>;
}

/** A listening HTTP stand-in for a model provider. The server-side model keeps
 * the broken scenarios deterministic while the agent still performs a real
 * network dispatch for every paid call. */
export async function startRequestCountingModelServer(): Promise<RequestCountingModelServer> {
  let requestCount = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/model') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      void (async () => {
        try {
          requestCount += 1;
          const result = await defaultMockModel.call(JSON.parse(body) as ModelCallArgs);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid model request' }));
        }
      })();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('request-counting model server failed to bind');
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    model: {
      async call(args): Promise<ModelCallResult> {
        const response = await fetch(`${url}/v1/model`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
        });
        if (!response.ok) {
          throw new Error(`request-counting model returned HTTP ${response.status}`);
        }
        return (await response.json()) as ModelCallResult;
      },
    },
    requestCount: () => requestCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
