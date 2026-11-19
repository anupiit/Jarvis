// Deterministic in-memory replacement for the HTTP transport.
// `handler(req, callIndex)` returns { status, body, headers, delayMs } or throws a Node-style error.

function createMockTransport(handler) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  async function request(req) {
    const index = calls.length;
    const parsedBody = req.body === undefined ? undefined : (typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
    calls.push({ ...req, body: parsedBody, startedAt: Date.now() });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const spec = await handler({ ...req, body: parsedBody }, index);
      if (spec && spec.delayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, spec.delayMs);
          if (req.signal) {
            req.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(Object.assign(new Error('Request cancelled'), { code: 'ABORT_ERR' }));
            }, { once: true });
          }
        });
      }
      const body = spec.body === undefined ? '' : (typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body));
      return { status: spec.status || 200, headers: spec.headers || {}, bodyText: body };
    } finally {
      inFlight--;
    }
  }

  return {
    request,
    calls,
    get maxInFlight() { return maxInFlight; },
    generateCalls() { return calls.filter(c => c.method === 'POST'); }
  };
}

function netError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createMockTransport, netError };
