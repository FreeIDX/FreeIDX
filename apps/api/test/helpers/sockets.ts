/**
 * 测试替身：Node 环境没有 Cloudflare 专属模块 `cloudflare:sockets`（vitest.config.ts alias 到本文件）。
 *
 * 默认行为与真实模块的「不可用」一致：`connect()` 直接抛错，需要建连的用例请先 `setSmtpScript()` 装一台
 * 脚本化的假 SMTP 服务器（按顺序匹配客户端命令并回预置应答），用 `smtpCommands()` 断言客户端发了什么。
 */

/** 一步：期望收到的客户端命令 + 要回的应答行（应答行需自带响应码，如 '250 OK'） */
export interface SmtpStep {
  match: RegExp;
  replies: string[];
  /** 回完应答后断开连接（模拟服务端收信即断链，用于验证 QUIT 容错） */
  close?: boolean;
}

interface FakeSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: () => Promise<void>;
  startTls: () => FakeSocket;
}

let script: SmtpStep[] | null = null;
let stepIdx = 0;
let commands: string[] = [];

/** 装一台假 SMTP 服务器：连接建立后立即发 220 问候，之后按 steps 顺序应答 */
export function setSmtpScript(steps: SmtpStep[]): void {
  script = steps;
  stepIdx = 0;
  commands = [];
}

/** 卸载假服务器（恢复「建连即抛」），改完用例必须调，避免污染其他文件 */
export function resetSmtpScript(): void {
  script = null;
  stepIdx = 0;
  commands = [];
}

/** 客户端实际发出的命令序列（断言用；不含 DATA 正文与 QUIT 之后的内容以外的东西） */
export function smtpCommands(): string[] {
  return commands;
}

function makeSocket(steps: SmtpStep[]): FakeSocket {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const push = (s: string): void => {
    try {
      ctrl?.enqueue(enc.encode(s));
    } catch {
      /* 已关闭 */
    }
  };
  push('220 fake ESMTP ready\r\n');

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const text = dec.decode(chunk);
      // DATA 正文是一次多行写入：不参与命令匹配（首行换行不在末尾即视为正文）
      if (text.includes('\r\n') && text.indexOf('\r\n') < text.length - 2) return;
      const cmd = text.replace(/\r\n$/, '');
      commands.push(cmd);
      const step = steps[stepIdx];
      if (!step || !step.match.test(cmd)) {
        push('500 5.5.1 unexpected command\r\n');
        return;
      }
      stepIdx++;
      for (const r of step.replies) push(`${r}\r\n`);
      if (step.close) {
        try {
          ctrl?.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  });

  const socket: FakeSocket = {
    readable,
    writable,
    close: async () => {
      try {
        ctrl?.close();
      } catch {
        /* 已关闭 */
      }
    },
    startTls: () => socket,
  };
  return socket;
}

export function connect(...args: unknown[]): FakeSocket {
  if (!script) throw new Error(`cloudflare:sockets 在 Node 测试环境不可用（connect(${JSON.stringify(args)}))`);
  return makeSocket(script);
}
