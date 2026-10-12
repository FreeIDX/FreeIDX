/**
 * cloudflare:sockets（TCP Sockets API）最小类型声明。
 * 标准 @cloudflare/workers-types 未含该模块（在 experimental 出口才有），这里按官方 API 手写所需子集：
 * connect({hostname,port}, {secureTransport}) → Socket（readable/writable/startTls/close）。
 * 用途：SMTP 账号池直连（core/email.ts，§11.3）——25 端口出站被封，465（隐式 TLS）/587（STARTTLS）可用。
 */
declare module 'cloudflare:sockets' {
  type SecureTransport = 'off' | 'on' | 'starttls';

  interface SocketOptions {
    /** 'on'=连上即 TLS（465）；'starttls'=明文握手后手动 startTls() 升级（587）；'off'=全程明文（仅本地联调） */
    secureTransport?: SecureTransport;
    allowHostnameMismatch?: boolean;
    closedByPeer?: boolean;
  }

  interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    /** 升级到 TLS 并返回新 Socket（旧 socket 不得再读写；升级前需释放流上的锁） */
    startTls(): Socket;
    close(): Promise<void>;
  }

  type SocketAddress = string | { hostname: string; port: number };

  export function connect(address: SocketAddress, options?: SocketOptions): Socket;
}
