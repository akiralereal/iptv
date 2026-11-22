import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonFileSync } from '../../../utils/fileUtil.js';
import { AppError } from './common.mjs';

const defaultPort = 1906;

export class HongguoEmbyPort {
  #server;
  #error;
  #pending = Promise.resolve();

  constructor({ file, mainPort, createServer, host, initialPort }) {
    this.file = file;
    this.mainPort = mainPort;
    this.createServer = createServer;
    this.host = host;
    this.port = defaultPort;
    this.initialPort = initialPort;
  }

  status() {
    return { port: this.port, listeningPort: this.#server?.address()?.port, error: this.#error };
  }

  #enqueue(change) {
    const result = this.#pending.then(change);
    this.#pending = result.catch(() => {});
    return result;
  }

  start() {
    return this.#enqueue(async () => {
      try {
        const configured = this.initialPort?.trim();
        let port = configured ? Number(configured) : defaultPort;
        try { port = JSON.parse(readFileSync(this.file, 'utf8')).port; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (Number.isInteger(port) && port >= 1 && port <= 65535) this.port = port;
        await this.#activate(port, false);
      } catch (error) {
        this.#error = error instanceof AppError ? error.message : '无法读取红果 Emby 端口设置，请重新保存端口。';
        throw error;
      }
    });
  }

  set(port) {
    return this.#enqueue(() => this.#activate(port, true));
  }

  async #activate(port, save) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === this.mainPort) {
      throw new AppError('INVALID_EMBY_PORT', '请输入 1–65535 之间且不同于 IPTV 主端口的整数。', 400);
    }

    const previous = this.#server;
    const next = previous?.address()?.port === port ? previous : this.createServer();
    if (next !== previous) {
      try {
        next.listen(port, this.host);
        await once(next, 'listening');
      } catch (error) {
        if (error.code === 'EADDRINUSE') throw new AppError('EMBY_PORT_IN_USE', `端口 ${port} 已被占用，请换一个端口。`, 409);
        throw new AppError('EMBY_PORT_LISTEN_FAILED', `无法监听端口 ${port}，请检查端口设置。`, 503);
      }
    }

    if (save) {
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        writeJsonFileSync(this.file, { port });
      } catch {
        if (next !== previous) next.close();
        throw new AppError('EMBY_PORT_SAVE_FAILED', '保存红果 Emby 端口失败，请检查数据目录权限。', 503);
      }
    }

    this.#server = next;
    this.port = port;
    this.#error = undefined;
    if (previous && previous !== next) previous.close();
  }

  async close() {
    await this.#pending;
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise(resolve => server.close(resolve));
  }
}
