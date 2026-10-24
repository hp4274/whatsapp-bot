/**
 * Dev proxy to the API. The live event stream (/api/events) is a long-lived
 * connection: whenever the API restarts (node --watch) or a laptop sleeps, the
 * socket is reset and the browser's EventSource reconnects on its own. Vite
 * logs every such reset as an error, so those are swallowed here; any other
 * proxy failure still prints.
 */
export default {
  '/api': {
    target: 'http://127.0.0.1:3000',
    secure: false,
    changeOrigin: true,
    timeout: 600000,
    configure: (proxy) => {
      // Vite adds its own 'error' listener (the "[vite] http proxy error" line) after this
      // runs, so a listener alone can't silence it: drop the reset before any listener sees it.
      const emit = proxy.emit.bind(proxy);
      proxy.emit = (event, err, req, res, ...rest) => {
        if (event === 'error' && req?.url?.startsWith('/api/events') && err?.code === 'ECONNRESET') {
          // Hand the browser a clean end so EventSource retries at once.
          if (res && !res.writableEnded) res.end();
          return true;
        }
        return emit(event, err, req, res, ...rest);
      };
      proxy.on('error', (err, req, res) => {
        console.error(`[proxy] ${req.url}: ${err.message}`);
        if (res && !res.headersSent && typeof res.writeHead === 'function') {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errors: [`API unreachable: ${err.message}`] }));
        }
      });
    },
  },
  // Tracked campaign links (public redirect, served by the API). The trailing
  // slash matters: a bare '/l' prefix would also swallow '/login'.
  '/l/': {
    target: 'http://127.0.0.1:3000',
    secure: false,
    changeOrigin: true,
  },
};
