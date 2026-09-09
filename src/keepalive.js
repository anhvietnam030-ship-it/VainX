const http = require('http');
const https = require('https');
const config = require('../config');

function iosPlayRedirectHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>Đang mở Vainglory...</title>
</head>
<body>
  <p>Đang mở Vainglory...</p>
  <script>
    window.location.href = ${JSON.stringify(config.APP_URL_SCHEME)};
    setTimeout(function () {
      window.location.href = ${JSON.stringify(config.IOS_STORE_URL)};
    }, 1200);
  </script>
</body>
</html>`;
}

function startKeepAliveServer() {
  const port = process.env.PORT || 3000;

  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/play')) {
      const ua = req.headers['user-agent'] || '';
      const isIOS = /iPhone|iPad|iPod/i.test(ua);

      if (isIOS) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(iosPlayRedirectHtml());
      } else {
        res.writeHead(302, { Location: config.ANDROID_STORE_URL });
        res.end();
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Vainglory Lobby Bot dang chay OK.');
  });

  // ✅ SỬA: thêm '0.0.0.0' để Render health check có thể kết nối
  server.listen(port, '0.0.0.0', () => {
    console.log(`Keep-alive HTTP server dang lang nghe tren cong ${port} (chi de qua port-check, khong dung de goi API).`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Cổng ${port} đang bị chiếm. Vui lòng kiểm tra hoặc đổi PORT trong environment.`);
    } else {
      console.error('❌ Lỗi server keep-alive:', err);
    }
  });

  return server;
}

function startSelfPing() {
  const url = process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL;
  if (!url) {
    console.log('SELF_PING_URL/RENDER_EXTERNAL_URL chua duoc khai -> bo qua tu-ping (binh thuong neu chay local).');
    return;
  }

  const INTERVAL_MS = 10 * 60 * 1000;
  setInterval(() => {
    https
      .get(url, (res) => {
        res.resume();
        console.log(`Self-ping ${url} -> status ${res.statusCode}`);
      })
      .on('error', (err) => console.error('Self-ping loi:', err.message));
  }, INTERVAL_MS);

  console.log(`Da bat self-ping toi ${url} moi ${INTERVAL_MS / 60000} phut.`);
}

module.exports = { startKeepAliveServer, startSelfPing };