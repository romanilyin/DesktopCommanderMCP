#!/usr/bin/env node

// MUST be first: raises the libuv threadpool size before any fs work is
// submitted. See src/bootstrap.ts for why import order matters.
import './bootstrap.js';
import { FilteredStdioServerTransport } from './custom-stdio.js';
import { configManager } from './config-manager.js';
import { logger } from './utils/logger.js';

// Store messages to defer until after initialization
const deferredMessages: Array<{ level: string, message: string }> = [];
function deferLog(level: string, message: string) {
  deferredMessages.push({ level, message });
}

async function runServer() {
  const command = process.argv[2];
  if (command === 'remote' || command === 'setup' || command === 'remove') {
    process.stderr.write(
      `SGG Local MCP: "${command}" is a retired command and is no longer supported. ` +
      'For local setup, use local/windows/Install.ps1; see README.md for setup and removal instructions.\n'
    );
    process.exit(2);
  }

  try {
    // Retired commands exit before loading tool history or probing the system.
    const { server, flushDeferredMessages } = await import('./server.js');
    // Create transport FIRST so all logging gets properly buffered
    // This must happen before any code that might use logger.*
    const transport = new FilteredStdioServerTransport();

    // Export transport for use throughout the application
    global.mcpTransport = transport;

    try {
      deferLog('info', 'Loading configuration...');
      await configManager.loadConfig();
      deferLog('info', 'Configuration loaded successfully');
    } catch (configError) {
      deferLog('error', `Failed to load configuration: ${configError instanceof Error ? configError.message : String(configError)}`);
      if (configError instanceof Error && configError.stack) {
        deferLog('debug', `Stack trace: ${configError.stack}`);
      }
      deferLog('warning', 'Continuing with in-memory configuration only');
      // Continue anyway - we'll use an in-memory config
    }

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // If this is a JSON parsing error, log it to stderr but don't crash
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        logger.error(`JSON parsing error: ${errorMessage}`);
        return; // Don't exit on JSON parsing errors
      }

      logger.error(`Uncaught exception: ${errorMessage}`);
      process.exit(1);
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', (reason) => {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);

      // If this is a JSON parsing error, log it to stderr but don't crash
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        logger.error(`JSON parsing rejection: ${errorMessage}`);
        return; // Don't exit on JSON parsing errors
      }

      logger.error(`Unhandled rejection: ${errorMessage}`);
      process.exit(1);
    });

    deferLog('info', 'Connecting server...');

    // Set up event-driven initialization completion handler
    server.oninitialized = () => {
      // This callback is triggered after the client sends the "initialized" notification
      // At this point, the MCP protocol handshake is fully complete
      transport.enableNotifications();

      // Flush all deferred messages from both index.ts and server.ts
      while (deferredMessages.length > 0) {
        const msg = deferredMessages.shift()!;
        transport.sendLog('info', msg.message);
      }
      flushDeferredMessages();

      // Now we can send regular logging messages
      transport.sendLog('info', 'Server connected successfully');
      transport.sendLog('info', 'MCP fully initialized, all startup messages sent');

    };

    await server.connect(transport);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`FATAL ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      logger.debug(error.stack);
    }

    // Send a structured error notification
    const errorNotification = {
      jsonrpc: "2.0" as const,
      method: "notifications/message",
      params: {
        level: "error",
        logger: "desktop-commander",
        data: `Failed to start server: ${errorMessage} (${new Date().toISOString()})`
      }
    };
    process.stdout.write(JSON.stringify(errorNotification) + '\n');

    process.exit(1);
  }
}

runServer().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`RUNTIME ERROR: ${errorMessage}`);
  console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
  process.stderr.write(JSON.stringify({
    type: 'error',
    timestamp: new Date().toISOString(),
    message: `Fatal error running server: ${errorMessage}`
  }) + '\n');

  process.exit(1);
});
