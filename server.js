const path = require('path');
const fs = require('fs');
const express = require('express');

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || 12000);
const HEROKU_API_KEY = process.env.PLATFORM_API_TOKEN || process.env.HEROKU_API_KEY || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';

const app = express();
app.use(express.json({ limit: '100kb' }));

function loadServices() {
  const raw = fs.readFileSync(path.join(__dirname, 'services.json'), 'utf8');
  return JSON.parse(raw);
}

function basicAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (user === DASHBOARD_USER && pass === DASHBOARD_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Dashboard", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

app.use(basicAuth);

function isHealthyStatus(status) {
  return status >= 200 && status < 500;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(service) {
  const started = Date.now();
  const url = service.checkUrl;
  const method = (service.method || 'GET').toUpperCase();
  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    const ms = Date.now() - started;
    return {
      id: service.id,
      name: service.name,
      url: service.checkUrl,
      herokuApp: service.herokuApp || null,
      frontend: service.frontend || null,
      healthy: isHealthyStatus(response.status),
      status: response.status,
      latencyMs: ms,
      error: null,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const message = err && err.name === 'AbortError' ? 'Timeout' : String(err.message || err);
    return {
      id: service.id,
      name: service.name,
      url: service.checkUrl,
      herokuApp: service.herokuApp || null,
      frontend: service.frontend || null,
      healthy: false,
      status: null,
      latencyMs: ms,
      error: message,
    };
  }
}

app.get('/api/status', async (_req, res) => {
  try {
    const services = loadServices();
    const results = await Promise.all(services.map((s) => checkOne(s)));
    res.json({ checkedAt: new Date().toISOString(), results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/test/:id', async (req, res) => {
  try {
    const services = loadServices();
    const service = services.find((s) => s.id === req.params.id);
    if (!service || !service.test) {
      return res.status(404).json({ error: 'Service or test configuration not found' });
    }
    const { url, method = 'GET', body } = service.test;
    const started = Date.now();
    const init = {
      method: method.toUpperCase(),
      headers: { Accept: 'application/json, text/plain, */*' },
    };
    if (body !== undefined && init.method !== 'GET' && init.method !== 'HEAD') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchWithTimeout(url, init, 20000);
    const latencyMs = Date.now() - started;
    const text = await response.text();
    const MAX = 4000;
    const truncated = text.length > MAX;
    res.json({
      id: service.id,
      request: { url, method: init.method, body: body ?? null },
      response: {
        status: response.status,
        latencyMs,
        contentType: response.headers.get('content-type') || null,
        body: truncated ? text.slice(0, MAX) : text,
        truncated,
      },
    });
  } catch (err) {
    const message = err && err.name === 'AbortError' ? 'Timeout' : String(err.message || err);
    res.status(502).json({ error: message });
  }
});

app.post('/api/restart/:id', async (req, res) => {
  try {
    if (!HEROKU_API_KEY) {
      return res.status(500).json({ error: 'HEROKU_API_KEY is not configured on the dashboard' });
    }
    const services = loadServices();
    const service = services.find((s) => s.id === req.params.id);
    if (!service || !service.herokuApp) {
      return res.status(404).json({ error: 'Service or Heroku app not configured' });
    }
    const response = await fetchWithTimeout(
      `https://api.heroku.com/apps/${service.herokuApp}/dynos`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.heroku+json; version=3',
          Authorization: `Bearer ${HEROKU_API_KEY}`,
        },
      },
      20000,
    );
    const ok = response.status >= 200 && response.status < 300;
    const text = await response.text();
    res.status(ok ? 200 : 502).json({
      id: service.id,
      herokuApp: service.herokuApp,
      ok,
      status: response.status,
      body: text,
    });
  } catch (err) {
    const message = err && err.name === 'AbortError' ? 'Timeout' : String(err.message || err);
    res.status(502).json({ error: message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});
