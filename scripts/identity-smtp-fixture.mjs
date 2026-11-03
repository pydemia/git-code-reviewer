// Disposable SMTP sink. Only reserved example.test addresses are accepted.
// Message content and action tokens are discarded; the status port exposes counts.
import net from 'node:net';
import http from 'node:http';

let messages = 0;
net
  .createServer((socket) => {
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('error', () => {});
    let buffer = '',
      data = false,
      sender = false,
      recipient = false,
      bytes = 0;
    socket.write('220 smtp.fixture ESMTP\r\n');
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return socket.destroy();
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            messages++;
            data = sender = recipient = false;
            socket.write('250 queued in disposable sink\r\n');
          }
        } else if (/^(EHLO|HELO) /i.test(line)) {
          socket.write('250 smtp.fixture\r\n');
        } else if (/^MAIL FROM:<[^<>@\s]+@example\.test>$/i.test(line)) {
          sender = true;
          recipient = false;
          socket.write('250 sender accepted\r\n');
        } else if (sender && /^RCPT TO:<[^<>@\s]+@example\.test>$/i.test(line)) {
          recipient = true;
          socket.write('250 recipient accepted\r\n');
        } else if (line === 'DATA' && sender && recipient) {
          data = true;
          socket.write('354 End data with dot\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n');
        } else if (line === 'RSET') {
          sender = recipient = false;
          socket.write('250 reset\r\n');
        } else if (line === 'NOOP') {
          socket.write('250 ok\r\n');
        } else {
          socket.write('550 fixture command or recipient rejected\r\n');
        }
      }
    });
  })
  .listen(8025, '0.0.0.0');
http
  .createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ messages }));
  })
  .listen(8026, '127.0.0.1');
