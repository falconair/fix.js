import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { createServer as createTlsServer, type TlsOptions } from 'node:tls';

/**
 * How long a peer gets to close its end once ours is done (a refused peer after
 * our Logout, a closed session's peer after our FIN) before its socket is reset.
 * A real timer: it is about the OS, not session time. Tests shorten it.
 */
export const peerClose = { waitMs: 1000 };

/** What a listening socket tells its server next about a connection the server took on. */
export interface OpenedConnection {
  /** The connection is ready for FIX: `socket` is the TCP socket itself, or for TLS, the TLS socket once its handshake is done. */
  ready(socket: Socket): void;
  /** Its TLS handshake failed or ran out of time. The listening socket closes the connection right after. */
  failed(error: Error): void;
}

/**
 * Makes a server's listening socket. `opened` is given each TCP connection the moment it opens (for TLS,
 * before its handshake), so every connection counts toward the server's limits from the start. It returns
 * undefined when the server closed the connection at once (over a limit, say).
 */
export type SocketServerFactory = (opened: (tcp: Socket) => OpenedConnection | undefined) => NetServer;

export const plainServer: SocketServerFactory = opened => createServer(tcp => { opened(tcp)?.ready(tcp); });

/** A TCP connection's two ends, as text. A TLS socket has its TCP connection's ends; a closed socket has none. */
function endsOf(socket: Socket): string | undefined {
  const { localAddress, localPort, remoteAddress, remotePort } = socket;
  if (localAddress === undefined || localPort === undefined || remoteAddress === undefined || remotePort === undefined) return undefined;
  return JSON.stringify([localAddress, localPort, remoteAddress, remotePort]);
}

/**
 * TLS. Node gives up on a handshake after `handshakeMs` (listen()'s limits.logonTimeout) without
 * progress, unless `options` set handshakeTimeout; the server's own logon timeout bounds it too.
 * A connection whose handshake fails or runs out of time is reported as failed and closed (Node
 * leaves one that ran out of time open).
 */
export function tlsServer(options: TlsOptions, handshakeMs: number): SocketServerFactory {
  return opened => {
    const server = createTlsServer({ handshakeTimeout: handshakeMs, ...options });
    // Connections in their handshake, by their two ends: no two open TCP connections share both ends.
    const handshaking = new Map<string, OpenedConnection>();
    /** The connection `socket` belongs to, no longer in its handshake. */
    const take = (socket: Socket): OpenedConnection | undefined => {
      const ends = endsOf(socket);
      const connection = ends === undefined ? undefined : handshaking.get(ends);
      if (connection !== undefined) handshaking.delete(ends!);
      return connection;
    };
    server.on('connection', (tcp: Socket) => {
      const connection = opened(tcp);
      const ends = endsOf(tcp);
      if (connection === undefined || ends === undefined) return;   // closed already: the server sees it close
      handshaking.set(ends, connection);
      tcp.once('close', () => { if (handshaking.get(ends) === connection) handshaking.delete(ends); });
    });
    server.on('secureConnection', socket => {
      const connection = take(socket);
      if (connection === undefined) socket.destroy();
      else connection.ready(socket);
    });
    // A peer that hangs up mid-handshake is reported here after its socket closed, when it has no ends any
    // more: it is only closed, like a plain connection that closes before its Logon. Any other is closed
    // here: Node leaves one that ran out of time open.
    server.on('tlsClientError', (error, socket) => {
      take(socket)?.failed(error);
      socket.destroy();
    });
    return server;
  };
}
