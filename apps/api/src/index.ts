import { buildApp } from './app.js';
import { getEnv } from './config/env.js';

async function startServer(): Promise<void> {
  const env = getEnv();
  const app = await buildApp({ env });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Received shutdown signal, terminating server gracefully');
    try {
      await app.close();
      app.log.info('Server stopped gracefully');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const address = await app.listen({
      port: env.PORT,
      host: env.HOST,
    });
    app.log.info({ address, environment: env.NODE_ENV }, 'DevDocs AI API server started');
  } catch (err) {
    app.log.fatal({ err }, 'Failed to start API server');
    process.exit(1);
  }
}

void startServer();
