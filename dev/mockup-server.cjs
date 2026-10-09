const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname);
const types = { '.html': 'text/html; charset=utf-8' };
http.createServer((req, res) => {
  const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
  const file = path.join(root, name || 'desktop-redesign-mockups.html');
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'text/html; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(3230, '127.0.0.1', () => console.log('serving dev/ on http://127.0.0.1:3230'));
