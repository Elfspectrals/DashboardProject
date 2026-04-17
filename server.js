const path = require('path');
const fs = require('fs');
const express = require('express');

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || 12000);

const app = express();

function loadServices() {
  const raw = fs.readFileSync(path.join(__dirname, 'services.json'), 'utf8');
  return JSON.parse(raw);
}

/**
 * Dyno is considered down for typical Heroku/router failure codes.
 */
function isHealthyStatus(status) {
  if (status >= 200 && status < 500) return true;
  return false;
}

async function checkOne(service) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url = service.checkUrl;
  const method = (service.method || 'GET').toUpperCase();

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    clearTimeout(timer);
    const ms = Date.now() - started;
    const healthy = isHealthyStatus(response.status);
    return {
      id: service.id,
      name: service.name,
      url: service.checkUrl,
      healthy,
      status: response.status,
      latencyMs: ms,
      error: null,
    };
  } catch (err) {
    clearTimeout(timer);
    const ms = Date.now() - started;
    const message = err && err.name === 'AbortError' ? 'Timeout' : String(err.message || err);
    return {
      id: service.id,
      name: service.name,
      url: service.checkUrl,
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
    res.json({
      checkedAt: new Date().toISOString(),
      results,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});
