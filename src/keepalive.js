const http = require('http');
const https = require('https');
const config = require('../config');

function playRedirectHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>Đang mở Vainglory...</title>
</head>
<body>
  <p>Đang mở Vainglory... nếu không tự mở, <a id="storelink" href="#">bấm vào đây</a>.</p>
  <script>
    var ua = navigator.userAgent || '';
    var isIOS = /iPhone|iPad|iPod/i.test(ua);
    var storeUrl = isIOS ? ${JSON.stringify(config.IOS_STORE_URL)} : ${JSON.stringify(config.ANDROID_STORE_URL)};
    document.getElementById('storelink').href = storeUrl;

    // Thử mở thẳng app đã cài trước
    window.location.href = ${JSON.stringify(config.APP_URL_SCHEME)};

    // Nếu 1.5s sau vẫn còn ở trang này (app chưa cài / không mở được) -> tự chuyển qua store
    setTimeout(function () {
      window.location.href = storeUrl;
    }, 1500);
  </script>
</body>
</html>`;
}

// Render (và nhiều nền tảng "Web Service" khác) yêu cầu app phải mở 1 cổng HTTP
// để nó dò xem app còn sống hay không. Bot Discord bản thân không cần cổng nào cả
// (chỉ kết nối WebSocket ra ngoài), nên nếu không có đoạn này Render sẽ báo
// "port scan timeout" rồi coi deploy là thất bại.
function startKeepAliveServer() {
  const port = process.env.PORT || 3000;

  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/play')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(playRedirectHtml());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Vainglory Lobby Bot dang chay OK.');
  });

  server.listen(port, () => {
    console.log(`Keep-alive HTTP server dang lang nghe tren cong ${port} (chi de qua port-check, khong dung de goi API).`);
  });

  return server;
}

// Render free Web Service tự "ngu" (spin down) sau 15 phut khong co request nao goi vao.
// Neu SELF_PING_URL duoc khai (hoac Render tu dien RENDER_EXTERNAL_URL), bot se tu goi
// vao chinh URL public cua no moi 10 phut de tinh la "co traffic", tranh bi ngu.
//
// LUU Y: day la meo lach, KHONG phai giai phap chinh thuc Render ho tro. Cach chac chan
// 100% van la nang len goi Starter tra phi ($7/thang, khong bi spin-down) hoac dung them
// mot dich vu ping ngoai (UptimeRobot, cron-job.org...) goi vao URL nay moi 5-10 phut.
function startSelfPing() {
  const url = process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL;
  if (!url) {
    console.log('SELF_PING_URL/RENDER_EXTERNAL_URL chua duoc khai -> bo qua tu-ping (binh thuong neu chay local).');
    return;
  }

  const INTERVAL_MS = 10 * 60 * 1000; // 10 phut/lan, luon < 15 phut Render cho phep
  setInterval(() => {
    https
      .get(url, (res) => {
        res.resume(); // xa data, tranh ro ri bo nho
        console.log(`Self-ping ${url} -> status ${res.statusCode}`);
      })
      .on('error', (err) => console.error('Self-ping loi:', err.message));
  }, INTERVAL_MS);

  console.log(`Da bat self-ping toi ${url} moi ${INTERVAL_MS / 60000} phut.`);
}

module.exports = { startKeepAliveServer, startSelfPing };
