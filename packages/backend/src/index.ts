import { buildApp } from './app.js';
import { env } from './config/env.js';
import { startWorkers, stopWorkers } from './workers/index.js';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`Server running on http://localhost:${env.PORT}`);

    // Warn if tracking URL is localhost (opens won't work for external recipients)
    if (env.TRACKING_BASE_URL.includes('localhost') || env.TRACKING_BASE_URL.includes('127.0.0.1')) {
      app.log.warn(
        'TRACKING_BASE_URL points to localhost — email open/click tracking will not work for external recipients. ' +
        'Set TRACKING_BASE_URL to a public URL (e.g. via ngrok) in .env.',
      );
    }

    // Start BullMQ workers after the server is listening
    startWorkers(app.io);

    // Graceful shutdown
    const shutdown = async () => {
      app.log.info('Shutting down...');
      await stopWorkers();
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
