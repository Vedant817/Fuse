import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

/**
 * A real, network-listening stand-in for an LLM provider's HTTP endpoint.
 * Used to prove — by counting actual inbound HTTP requests, not just
 * in-process function calls — that a tripped breaker results in zero
 * provider dispatches. Test/demo fixture only; never import from
 * production code (`@fuse/sdk/testing` is a separate package export so
 * this stays out of the default bundle).
 */
export interface FakeProvider {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    count += 1;
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echoedBytes: body.length }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake provider server failed to bind to a port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => count,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Sends one POST request to the fake provider, mimicking the shape of a
 * real dispatch: a JSON body, awaiting a JSON response. Intended to be
 * wrapped by `FuseGuard.guard()` in tests. */
export async function callFakeProvider(
  url: string,
  payload: unknown = { prompt: 'test' },
): Promise<unknown> {
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`fake provider returned HTTP ${res.status}`);
  }
  return res.json();
}
