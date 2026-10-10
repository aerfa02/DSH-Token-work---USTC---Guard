import { live2dDocument } from './live2d.js';
/** Register the endpoint explicitly in the Host Typert registry. */
export function mountSnapshotRemote(ctx, guard, ready) {
  let reported = false;
  const service = {
    async snapshot() {
      await ready;
      const snapshot = guard.snapshot();
      if (!reported) {
        reported = true;
        ctx.logger?.info?.('USTC Guard Client snapshot reached Host', {
          version: snapshot.runtimeVersion,
          routes: snapshot.routes?.map(route => ({ provider: route.provider, protected: route.protected, models: route.models?.length ?? 0 })),
        });
      }
      return snapshot;
    },
    async live2d() { return live2dDocument(); },
  };
  service.typertRemote = Object.freeze({ service, serviceKey: 'ustcGuard', namespace: 'ustcGuard' });
  ctx.provide('ustcGuard', service);
  return ctx.typert.register({
    package: '@local/dsh-ustc-api-guard', face: 'host', schemas: [],
    invocations: ['snapshot', 'live2d'].map(method => ({
      id: `@local/dsh-ustc-api-guard#ustcGuard/${method}`,
      service: 'ustcGuard', namespace: 'ustcGuard', method,
      invocation: { kind: 'direct' }, parameters: [],
      result: { mode: 'src-json' },
    })),
  });
}
