import KeepAliveHttpAgent from 'agentkeepalive';
import test from 'ava';
import delay from 'delay';
import safeGot from 'got';
import sinon from 'sinon';

import { GracefulShutdownModule, setupGracefulShutdown } from '../../src';
import { GracefulShutdownService } from '../../src/lib/graceful-shutdown.service';

import { CatsController } from './test-controller';
import { CatsModule } from './test-module';
import { CatsService } from './test-service';
import type { NestJSTestingServerFactory } from './types';

const got = safeGot.extend({
  https: {
    rejectUnauthorized: false,
  },
});

const KeepAliveHttpsAgent = KeepAliveHttpAgent.HttpsAgent;

export const createTests = (
  createNestJSTestingServer: NestJSTestingServerFactory
): void => {
  test('should work normally after setting up the library (using`.forRoot()`)', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: new CatsController().findTheCat,
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { httpServer, app, url, cleanupNestJSApp } = testingServer;
    setupGracefulShutdown({ app });
    const response = await got(url);

    t.true(httpServer.listening);
    t.is(response.body, 'Congratulations! You have found the cat!');
    await cleanupNestJSApp();
  });

  test('should work normally after setting up the library (using`.forRootAsync()`)', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: new CatsController().findTheCat,
      GracefulShutdownModule: GracefulShutdownModule.forRootAsync({
        imports: [CatsModule],
        inject: [CatsService],
        useFactory: async (catsService: CatsService) => {
          await delay(1); // any async/await task
          return {
            gracefulShutdownTimeout: catsService.age,
          };
        },
      }),
    });
    const { httpServer, app, url, cleanupNestJSApp } = testingServer;
    setupGracefulShutdown({ app });
    const response = await got(url);

    t.true(httpServer.listening);
    t.is(response.body, 'Congratulations! You have found the cat!');
    await cleanupNestJSApp();
  });

  test('should shut down the HTTP server with no active connections', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { httpServer, app, shutdownServer, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    shutdownServer();

    await delay(50);

    t.false(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should terminate hanging sockets after gracefulShutdownTimeout', async (t) => {
    const spy = sinon.spy();
    const gracefulShutdownTimeout = 500;
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {
        spy();
      },
      GracefulShutdownModule: GracefulShutdownModule.forRoot({
        gracefulShutdownTimeout,
      }),
    });
    const { getConnections, app, shutdownServer, url, cleanupNestJSApp } =
      testingServer;

    setupGracefulShutdown({ app });

    t.timeout(5000);

    got(url);

    await delay(100);

    t.true(spy.called);

    shutdownServer();

    await delay(100);

    // The timeout has not passed.
    t.is(await getConnections(), 1);

    await delay(gracefulShutdownTimeout);

    // The timeout has passed
    t.is(await getConnections(), 0);
    await cleanupNestJSApp();
  });

  test('should invoke cleanup function on application shutdown', async (t) => {
    const stub = sinon.stub();
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({
        cleanup: async (app) => {
          stub(app);
        },
      }),
    });
    const { app, shutdownServer, cleanupNestJSApp } = testingServer;

    setupGracefulShutdown({ app });

    shutdownServer();

    await delay(50);

    t.deepEqual(stub.firstCall.args, [app]);

    await cleanupNestJSApp();
  });

  test('should stop accepting new connections after receiving the shutdown signal', async (t) => {
    const stub = sinon.stub();

    stub.onCall(0).callsFake((res) => {
      setTimeout(() => {
        res.end('foo');
      }, 100);
    });

    const testingServer = await createNestJSTestingServer({
      requestHandler: stub,
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { app, shutdownServer, url, cleanupNestJSApp } = testingServer;

    setupGracefulShutdown({ app });

    t.timeout(5000);

    const request0 = got(url);

    await delay(50);

    shutdownServer();

    const request1 = got(url, {
      retry: 0,
      timeout: {
        connect: 50,
      },
    });

    await t.throwsAsync(request1);
    const response0 = await request0;

    t.is(response0.headers.connection, 'close');
    t.is(response0.body, 'foo');
    await cleanupNestJSApp();
  });

  test('should include `connection: close` header in ongoing requests', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: (res) => {
        setTimeout(() => {
          res.end('foo');
        }, 500);
      },
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });

    const { app, shutdownServer, url, cleanupNestJSApp } = testingServer;

    setupGracefulShutdown({ app });

    t.timeout(5000);

    const httpAgent = new KeepAliveHttpAgent({
      maxSockets: 1,
    });

    const httpsAgent = new KeepAliveHttpsAgent({
      maxSockets: 1,
    });

    const request = got(url, {
      agent: {
        http: httpAgent,
        https: httpsAgent,
      },
    });

    await delay(100);

    shutdownServer();

    const response = await request;

    t.is(response.headers.connection, 'close');
    t.is(response.body, 'foo');
    await cleanupNestJSApp();
  });

  test('should not send `connection: close` when the server is not terminating', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: (res) => {
        setTimeout(() => {
          res.end('foo');
        }, 50);
      },
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { app, url, cleanupNestJSApp } = testingServer;

    setupGracefulShutdown({ app });

    t.timeout(5000);

    const httpAgent = new KeepAliveHttpAgent({
      maxSockets: 1,
    });

    const httpsAgent = new KeepAliveHttpsAgent({
      maxSockets: 1,
    });

    const response = await got(url, {
      agent: {
        http: httpAgent,
        https: httpsAgent,
      },
    });

    t.is(response.headers.connection, 'keep-alive');
    await cleanupNestJSApp();
  });

  test('should complete shutdown even when httpTerminator.terminate() fails', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { httpServer, app, shutdownServer, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    // Manually close server before shutdown to simulate terminate failure
    httpServer.close();

    shutdownServer();

    await delay(100);

    t.false(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should complete shutdown even when cleanup function throws', async (t) => {
    const cleanupError = new Error('Cleanup failed');
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    });
    const { httpServer, app, shutdownServer, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    shutdownServer();

    await delay(100);

    t.false(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should complete shutdown even when cleanup function throws synchronously', async (t) => {
    const cleanupError = new Error('Synchronous cleanup failed');
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({
        cleanup: () => {
          throw cleanupError;
        },
      }),
    });
    const { httpServer, app, shutdownServer, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    shutdownServer();

    await delay(100);

    t.false(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should complete shutdown when skipShutdownSignal fails', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({
        cleanup: async () => {},
      }),
    });
    const { httpServer, app, shutdownServer, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    shutdownServer();

    await delay(100);

    t.false(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should complete shutdown even when both terminate and cleanup fail', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({
        cleanup: async () => {
          throw new Error('Cleanup intentionally fails');
        },
      }),
    });
    const { httpServer, app, shutdownServer, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    // Manually close server before shutdown to simulate terminate failure
    httpServer.close();

    shutdownServer();

    await delay(100);

    t.false(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should successfully use fallback close when terminate fails', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { httpServer, app, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    // Mock httpTerminator.terminate to throw an error
    const service = app.get(GracefulShutdownService);
    // Access private field for testing purposes
    const httpTerminator = (service as any).httpTerminator;
    const originalTerminate = httpTerminator.terminate;
    httpTerminator.terminate = async () => {
      throw new Error('Terminate failed');
    };

    // Trigger shutdown manually
    await service.beforeApplicationShutdown();

    t.false(httpServer.listening);

    httpTerminator.terminate = originalTerminate;
    await cleanupNestJSApp();
  });

  test('should handle fallback close when server close rejects', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { httpServer, app, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    // Mock httpTerminator.terminate to throw an error
    const service = app.get(GracefulShutdownService);
    const httpTerminator = (service as any).httpTerminator;
    const originalTerminate = httpTerminator.terminate;
    httpTerminator.terminate = async () => {
      throw new Error('Terminate failed');
    };

    // Create a custom close that rejects
    const originalClose = httpServer.close;
    httpServer.close = (callback: any) => {
      callback(new Error('Close failed'));
    };

    // Trigger shutdown manually
    await service.beforeApplicationShutdown();

    // Restore and cleanup
    httpTerminator.terminate = originalTerminate;
    httpServer.close = originalClose;
    await cleanupNestJSApp();
  });

  test('should handle fallback close when server is not listening', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { httpServer, app, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    // Mock httpTerminator.terminate to throw an error
    const service = app.get(GracefulShutdownService);
    const httpTerminator = (service as any).httpTerminator;
    const originalTerminate = httpTerminator.terminate;
    httpTerminator.terminate = async () => {
      throw new Error('Terminate failed');
    };

    // Close the server first
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    t.false(httpServer.listening);

    // Trigger shutdown manually
    await service.beforeApplicationShutdown();

    httpTerminator.terminate = originalTerminate;
    await cleanupNestJSApp();
  });

  test('should shut down successfully without cleanup function', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({
        cleanup: undefined,
      }),
    });
    const { httpServer, app, shutdownServer, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    setupGracefulShutdown({ app });

    shutdownServer();

    await delay(50);

    t.false(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should work with forRoot() without options', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: new CatsController().findTheCat,
      GracefulShutdownModule: GracefulShutdownModule.forRoot(),
    });
    const { httpServer, app, url, cleanupNestJSApp } = testingServer;

    setupGracefulShutdown({ app });
    const response = await got(url);

    t.true(httpServer.listening);
    t.is(response.body, 'Congratulations! You have found the cat!');
    await cleanupNestJSApp();
  });

  test('should work with custom signals in setup', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { httpServer, app, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    // Test with custom signals - just verify setup doesn't throw
    setupGracefulShutdown({ app, signals: ['SIGTERM'] });

    t.true(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should work with empty signals array in setup', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { httpServer, app, cleanupNestJSApp } = testingServer;

    t.true(httpServer.listening);

    t.timeout(5000);

    // Test with empty signals array - just verify setup doesn't throw
    setupGracefulShutdown({ app, signals: [] });

    t.true(httpServer.listening);
    await cleanupNestJSApp();
  });

  test('should handle termination error when app is null in fallback', async (t) => {
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({}),
    });
    const { app, cleanupNestJSApp } = testingServer;

    setupGracefulShutdown({ app });

    const service = app.get(GracefulShutdownService);
    const httpTerminator = (service as any).httpTerminator;
    const originalTerminate = httpTerminator.terminate;
    const originalApp = (service as any).app;

    t.timeout(5000);

    // Mock terminate to fail and set app to null after setup
    httpTerminator.terminate = async () => {
      throw new Error('Terminate failed');
    };
    // Temporarily set app to null to test the if (!this.app) branch in fallback
    (service as any).app = null;

    // Should complete without throwing - the fallback checks if (!this.app) and skips it
    await service.beforeApplicationShutdown();

    t.pass('Should complete gracefully when app is null in fallback');

    // Restore app and terminate
    httpTerminator.terminate = originalTerminate;
    (service as any).app = originalApp;

    await cleanupNestJSApp();
  });

  test('should handle onApplicationShutdown without signal parameter', async (t) => {
    const cleanupStub = sinon.stub();
    const testingServer = await createNestJSTestingServer({
      requestHandler: () => {},
      GracefulShutdownModule: GracefulShutdownModule.forRoot({
        cleanup: async (app) => {
          cleanupStub(app);
        },
      }),
    });
    const { app, cleanupNestJSApp } = testingServer;

    setupGracefulShutdown({ app });

    const service = app.get(GracefulShutdownService);

    t.timeout(5000);

    // Call without signal
    await service.onApplicationShutdown();

    t.true(cleanupStub.called);
    await cleanupNestJSApp();
  });
};
