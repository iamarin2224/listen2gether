#!/usr/bin/env node

/**
 * SyncWave Unified Gateway
 *
 * Listens on PORT 3000 (the single port you tunnel via ngrok).
 * Proxies:
 *   - /api/*        -> FastAPI Backend (port 8000)
 *   - /socket.io/*  -> FastAPI + python-socketio (port 8000) [HTTP + full WebSocket upgrade]
 *   - Everything else -> Next.js Frontend (port 3001)
 *
 * Built using native Node.js http and net modules (zero extra dependencies).
 */

const http = require('http');
const net = require('net');

const GATEWAY_PORT = parseInt(process.env.PORT || '3000', 10);
const BACKEND_PORT = 8000;
const FRONTEND_PORT = 3001;

function getTargetPort(url = '') {
  if (url.startsWith('/api') || url.startsWith('/socket.io')) {
    return BACKEND_PORT;
  }
  return FRONTEND_PORT;
}

const server = http.createServer((req, res) => {
  const targetPort = getTargetPort(req.url);

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        // Forward client host information
        'x-forwarded-host': req.headers.host || '',
        'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http',
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error(`[Gateway] HTTP Proxy error for ${req.url} -> port ${targetPort}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Gateway Bad Gateway: upstream server not ready.');
    }
  });

  req.pipe(proxyReq);
});

// Handle WebSocket / HTTP Upgrade requests (CRITICAL FOR SOCKET.IO)
server.on('upgrade', (req, clientSocket, head) => {
  const targetPort = getTargetPort(req.url);

  const upstreamSocket = net.connect(
    {
      port: targetPort,
      host: '127.0.0.1',
    },
    () => {
      // Forward HTTP Upgrade request headers to target
      let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            rawRequest += `${key}: ${v}\r\n`;
          }
        } else if (value !== undefined) {
          rawRequest += `${key}: ${value}\r\n`;
        }
      }
      rawRequest += '\r\n';

      upstreamSocket.write(rawRequest);
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }

      // Pipe data bidirectionally between client and upstream server
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    }
  );

  upstreamSocket.on('error', (err) => {
    console.error(`[Gateway] Upgrade Proxy error for ${req.url} -> port ${targetPort}:`, err.message);
    clientSocket.destroy();
  });

  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
});

server.listen(GATEWAY_PORT, '0.0.0.0', () => {
  console.log(`==========================================================`);
  console.log(` SyncWave Gateway running on http://0.0.0.0:${GATEWAY_PORT}`);
  console.log(`   -> /api & /socket.io (HTTP + WS) routed to backend (8000)`);
  console.log(`   -> Frontend pages routed to Next.js (3001)`);
  console.log(` Single-tunnel ready: "ngrok http ${GATEWAY_PORT}"`);
  console.log(`==========================================================`);
});
