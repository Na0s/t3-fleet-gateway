import { loadConfig, type Paths } from '../config.ts';
import { GatewayError } from '../errors.ts';
import { openServices, type GatewayServices } from '../gateway.ts';
import { silentLogger } from '../log.ts';
import { listBots, sendBotMessage } from '../bots/service.ts';
import { readRuntimeManifest, serviceEnvironment } from '../webhooks/runtimeLoader.ts';
import type { CliIo } from './main.ts';

/** Reject oversized or stalled pipes without retaining their contents in diagnostics. */
export function readBotInput(stream: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: boolean) => {
      clearTimeout(timer);
      stream.off('data', data); stream.off('end', end); stream.off('error', failed);
      stream.pause();
      try {
        if (error) throw new Error();
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch { reject(new GatewayError('invalid_argument', 'Expected bounded bot-message JSON on stdin.')); }
      chunks.length = 0;
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 64 * 1024) finish(true); else chunks.push(buffer);
    };
    const end = () => finish();
    const failed = () => finish(true);
    const timer = setTimeout(failed, 5000);
    stream.on('data', data); stream.once('end', end); stream.once('error', failed);
  });
}

export async function runBots(paths: Paths, io: CliIo, action: 'list' | 'send'): Promise<number> {
  let services: GatewayServices | undefined;
  try {
    if (!io.env.T3FG_RUNTIME_ROUTES) throw new GatewayError('config_invalid', 'Set T3FG_RUNTIME_ROUTES to the private bot routing manifest.');
    const manifest = readRuntimeManifest(io.env.T3FG_RUNTIME_ROUTES);
    if (action === 'list') {
      io.out(JSON.stringify(listBots(manifest)));
      return 0;
    }
    const input = await readBotInput(io.input ?? process.stdin);
    const config = loadConfig(paths.configPath);
    const receipt = await sendBotMessage(input, { config, manifest, dataDir: paths.dataDir, env: io.env,
      verify: async (host, message) => {
        services ??= openServices({ config, dataDir: paths.dataDir, logger: silentLogger, commandEnv: serviceEnvironment(io.env) });
        const client = services.registry.client(host);
        const environment = await client.environmentRead({ retry: false });
        const { thread } = await client.readThread({ threadId: message.threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 });
        return { environmentId: environment.environmentId, threadId: thread.threadId, projectId: thread.projectId, archived: thread.archived };
      },
    });
    io.out(JSON.stringify(receipt));
    return 0;
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : 'internal_error';
    // Upstream/network/parser errors may contain private content; only the stable code leaves this boundary.
    io.err(`error (${code}): Bot command failed; check private routing, input and host enrollment.`);
    return 1;
  } finally { await services?.close(); }
}
