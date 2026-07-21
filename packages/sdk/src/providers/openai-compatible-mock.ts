import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

/**
 * A real, network-listening stand-in for an OpenAI-compatible
 * `/chat/completions` endpoint (Groq, NVIDIA Build, etc.) — test/demo
 * fixture only, mirroring `../testing.ts`'s generic fake provider but
 * shaped like a real chat-completions response so adapter-level request/
 * response handling is exercised faithfully, not just the generic HTTP
 * plumbing. Never imported from production code.
 */
export interface MockOpenAiCompatibleServer {
  url: string;
  requestCount: () => number;
  lastAuthorizationHeader: () => string | undefined;
  close: () => Promise<void>;
}

export async function startMockOpenAiCompatibleServer(): Promise<MockOpenAiCompatibleServer> {
  let count = 0;
  let lastAuth: string | undefined;
  const server: Server = createServer((req, res) => {
    count += 1;
    lastAuth = req.headers.authorization;
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const parsed = JSON.parse(body) as { model: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock-1',
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'mock response' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock OpenAI-compatible server failed to bind to a port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => count,
    lastAuthorizationHeader: () => lastAuth,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
