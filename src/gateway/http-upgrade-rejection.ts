import type { Duplex } from "node:stream";

export function rejectUnauthorizedUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
}
