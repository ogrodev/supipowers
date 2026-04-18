const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const PORT = process.env.SUPI_VISUAL_PORT || (49152 + Math.floor(Math.random() * 16383));
const HOST = process.env.SUPI_VISUAL_HOST || '127.0.0.1';
const URL_HOST = process.env.SUPI_VISUAL_URL_HOST || (HOST === '127.0.0.1' ? 'localhost' : HOST);
const SCREEN_DIR = process.env.SUPI_VISUAL_DIR || '/tmp/supi-visual';

if (!fs.existsSync(SCREEN_DIR)) {
  fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

// Load frame template and helper script once at startup
const frameTemplate = fs.readFileSync(path.join(__dirname, 'frame-template.html'), 'utf-8');
const helperScript = fs.readFileSync(path.join(__dirname, 'helper.js'), 'utf-8');
const helperInjection = `<script>\n${helperScript}\n</script>`;

// Detect whether content is a full HTML document or a bare fragment
function isFullDocument(html) {
  const trimmed = html.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

// Wrap a content fragment in the frame template
function wrapInFrame(content) {
  return frameTemplate.replace('<!-- CONTENT -->', content);
}

function injectHelper(html) {
  if (html.includes('</body>')) {
    return html.replace('</body>', `${helperInjection}\n</body>`);
  }
  return html + helperInjection;
}

function renderHtml(raw) {
  const html = isFullDocument(raw) ? raw : wrapInFrame(raw);
  return injectHelper(html);
}

function resolveArtifactPath(requestPath) {
  if (!requestPath || requestPath.startsWith('.')) return null;

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const normalizedPath = path.normalize(decodedPath).replace(/^([/\\])+/, '');
  if (!normalizedPath || normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
    return null;
  }

  const artifactPath = path.resolve(SCREEN_DIR, normalizedPath);
  const relative = path.relative(SCREEN_DIR, artifactPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(artifactPath)) {
    return null;
  }

  return artifactPath;
}

function serveArtifact(res, artifactPath) {
  if (artifactPath.endsWith('.html')) {
    const raw = fs.readFileSync(artifactPath, 'utf-8');
    res.type('html').send(renderHtml(raw));
    return;
  }

  res.sendFile(artifactPath);
}


// Find the newest .html file in the directory by mtime
function getNewestScreen() {
  const files = fs.readdirSync(SCREEN_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => ({
      name: f,
      path: path.join(SCREEN_DIR, f),
      mtime: fs.statSync(path.join(SCREEN_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].path : null;
}

const WAITING_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>Supipowers Visual Companion</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; }
    h1 { color: #333; }
    p { color: #666; }
    @media (prefers-color-scheme: dark) {
      body { background: #1d1d1f; }
      h1 { color: #f5f5f7; }
      p { color: #86868b; }
    }
  </style>
</head>
<body>
  <h1>Supipowers Visual Companion</h1>
  <p>Waiting for content to be pushed...</p>
</body>
</html>`;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));

  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    console.log(JSON.stringify({ source: 'user-event', ...event }));
    // Write user events to .events file for agent to read
    if (event.choice) {
      const eventsFile = path.join(SCREEN_DIR, '.events');
      fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
    }
  });
});

// Serve newest screen at the root, and session artifacts on direct paths
app.get('/', (req, res) => {
  const screenFile = getNewestScreen();
  if (!screenFile) {
    res.type('html').send(renderHtml(WAITING_PAGE));
    return;
  }

  serveArtifact(res, screenFile);
});

app.get(/^\/(.+)$/, (req, res) => {
  const artifactPath = resolveArtifactPath(req.params[0]);
  if (!artifactPath) {
    res.status(404).type('text').send(`Cannot GET ${req.path}`);
    return;
  }

  serveArtifact(res, artifactPath);
});

// Watch for new or changed .html files
chokidar.watch(SCREEN_DIR, { ignoreInitial: true })
  .on('add', (filePath) => {
    if (filePath.endsWith('.html')) {
      // Clear events from previous screen
      const eventsFile = path.join(SCREEN_DIR, '.events');
      if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);
      console.log(JSON.stringify({ type: 'screen-added', file: filePath }));
      clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reload' }));
        }
      });
    }
  })
  .on('change', (filePath) => {
    if (filePath.endsWith('.html')) {
      console.log(JSON.stringify({ type: 'screen-updated', file: filePath }));
      clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reload' }));
        }
      });
    }
  });

server.listen(PORT, HOST, () => {
  const info = JSON.stringify({
    type: 'server-started',
    port: PORT,
    host: HOST,
    url_host: URL_HOST,
    url: `http://${URL_HOST}:${PORT}`,
    screen_dir: SCREEN_DIR
  });
  console.log(info);
  fs.writeFileSync(path.join(SCREEN_DIR, '.server-info'), info + '\n');
});
