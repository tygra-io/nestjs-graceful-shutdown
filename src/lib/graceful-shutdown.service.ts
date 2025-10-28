import type {
  BeforeApplicationShutdown,
  INestApplication,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { HttpTerminator } from '@tygra/http-terminator';
import { createHttpTerminator } from '@tygra/http-terminator';

import {
  DEFAULT_CONFIG_OPTIONS,
  GRACEFUL_SHUTDOWN_CONFIG_OPTIONS,
} from './constant';
import { IGracefulShutdownConfigOptions } from './graceful-shutdown.interface';

const SetupFunctionNotInvoked = new Error(
  'You have to invoke `setupGracefulShutdown({ app })` to ensure proper functioning of `nestjs-graceful-shutdown`.'
);

@Injectable()
export class GracefulShutdownService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(GracefulShutdownService.name);

  private httpTerminator: HttpTerminator | null = null;
  private app: INestApplication | null = null;

  constructor(
    @Inject(GRACEFUL_SHUTDOWN_CONFIG_OPTIONS)
    private options: IGracefulShutdownConfigOptions
  ) {
    this.options = {
      cleanup: options.cleanup ?? DEFAULT_CONFIG_OPTIONS.cleanup,
      gracefulShutdownTimeout:
        options.gracefulShutdownTimeout ??
        DEFAULT_CONFIG_OPTIONS.gracefulShutdownTimeout,
    };
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.httpTerminator) {
      throw SetupFunctionNotInvoked;
    }

    try {
      await this.httpTerminator.terminate();
    } catch (error) {
      this.logger.error('Failed to terminate HTTP server gracefully', error);

      // Fallback: attempt direct server close
      try {
        if (this.app) {
          const httpServer = this.app.getHttpServer();
          if (httpServer && httpServer.listening) {
            await new Promise<void>((resolve, reject) => {
              httpServer.close((err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            });
          }
        }
      } catch (fallbackError) {
        this.logger.warn('Fallback server close also failed', fallbackError);
      }
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.app) {
      throw SetupFunctionNotInvoked;
    }

    if (this.options.cleanup) {
      try {
        await this.options.cleanup(this.app, signal);
      } catch (error) {
        this.logger.error(
          `Cleanup function failed${signal ? ` (signal: ${signal})` : ''}`,
          error
        );
      }
    }

    if (signal) {
      try {
        this.skipShutdownSignal(signal);
      } catch (error) {
        this.logger.warn(`Failed to handle shutdown signal: ${signal}`, error);
      }
    }
  }

  skipShutdownSignal(signal: string): void {
    const skipSignal = (): void => {
      process.removeListener(signal, skipSignal);
    };

    process.on(signal, skipSignal);
  }

  setupGracefulShutdown(app: INestApplication): void {
    this.app = app;

    this.httpTerminator = createHttpTerminator({
      gracefulTerminationTimeout: this.options.gracefulShutdownTimeout,
      server: app.getHttpServer(),
      logger: this.logger,
    });
  }
}
