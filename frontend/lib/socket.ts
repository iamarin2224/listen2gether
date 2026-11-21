import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;
let currentUrl: string | null = null;

/**
 * Returns a singleton Socket.IO socket connected to `backendUrl`.
 * If a socket already exists for the same URL it is reused.
 */
export function getSocket(backendUrl: string): Socket {
  if (socket && currentUrl === backendUrl) {
    return socket;
  }

  // Disconnect old socket if URL changed
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  socket = io(backendUrl, {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    transports: ['polling', 'websocket'],
  });

  currentUrl = backendUrl;
  return socket;
}
