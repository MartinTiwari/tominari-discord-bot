'use strict';

const { fetch, Agent, setGlobalDispatcher } = require('undici');

const log = require('./logger')('http');

/**
 * Fetch wrapper with a timeout, retries with backoff, and a simple per-host
 * rate limiter. Every outbound API/RSS call in the bot goes through here so a
 * flaky source can never hang a scheduler forever.
 *
 * We use undici's `fetch` rather than the global one so the connection pool is
 * ours to configure and, in one-shot scripts, to close — Node's built-in
 * dispatcher offers no supported way to do either.
 */

const dispatcher = new Agent({
  connectTimeout: 10_000,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
});
setGlobalDispatcher(dispatcher);

const DEFAULT_TIMEOUT = 15_000;
const MIN_INTERVAL_MS = 800;         // minimum gap between calls to one host
const lastCallByHost = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const last = lastCallByHost.get(host) || 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastCallByHost.set(host, Date.now());
}

/**
 * @returns {Promise<Response>} a successful response
 * @throws when every attempt fails or the server returns a non-2xx status
 */
async function request(url, { retries = 2, timeout = DEFAULT_TIMEOUT, ...init } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'User-Agent': 'TominariBot/1.0 (+https://github.com/tominari)',
          Accept: '*/*',
          ...(init.headers || {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res;
    } catch (err) {
      lastError = err;
      const label = err.name === 'AbortError' ? `timeout after ${timeout}ms` : err.message;
      log.debug(`attempt ${attempt + 1}/${retries + 1} failed for ${url}: ${label}`);
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Request failed for ${url}: ${lastError?.message || 'unknown error'}`);
}

async function getJson(url, options) {
  const res = await request(url, options);
  return res.json();
}

async function getText(url, options) {
  const res = await request(url, options);
  return res.text();
}

/** Never-throwing variant: returns `fallback` and logs instead of rejecting. */
async function safeJson(url, options, fallback = null) {
  try {
    return await getJson(url, options);
  } catch (err) {
    log.warn(err.message);
    return fallback;
  }
}

/**
 * Close the keep-alive connection pool. Long-running processes never need this,
 * but a one-shot script would otherwise sit idle until the sockets time out
 * instead of exiting when its work is done.
 */
async function shutdown() {
  try {
    await dispatcher.close();
  } catch { /* already closed */ }
}

module.exports = { request, getJson, getText, safeJson, sleep, shutdown };
