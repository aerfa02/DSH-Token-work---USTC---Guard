import { hostOf, USTC_HOST, snapshotBaseURL, adapterWithMethod } from './identity.js';
export const USTC_STREAM_IDLE_TIMEOUT_MS = 600000;
const adapters = new WeakMap();

/** Override the per-call snapshot, never the saved or shared provider configuration. */
export function attachUstcTimeout(adapter, enabled = () => true) {
  adapter = adapterWithMethod(adapter, 'streamWithSnapshot');
  if (!adapter) return null;
  let entry = adapters.get(adapter);
  if (!entry || adapter.streamWithSnapshot !== entry.wrapper) {
    const original = adapter.streamWithSnapshot;
    entry = { original, owners: new Set() };
    entry.wrapper = function (options, snapshot) {
      const profile = snapshot?.profiles?.get(options?.provider);
      const endpoint = snapshotBaseURL(snapshot, options?.provider, options?.model);
      if (profile && [...entry.owners].some(active => active()) && hostOf(endpoint) === USTC_HOST) {
        const profiles = new Map(snapshot.profiles);
        profiles.set(options.provider, { ...profile, streamIdleTimeoutMs: USTC_STREAM_IDLE_TIMEOUT_MS });
        return original.call(this, options, { ...snapshot, profiles });
      }
      return original.call(this, options, snapshot);
    };
    adapters.set(adapter, entry);
    adapter.streamWithSnapshot = entry.wrapper;
  }
  // Each lease is unique even when callers reuse the same predicate.
  const owner = () => enabled();
  entry.owners.add(owner);
  return () => {
    entry.owners.delete(owner);
    if (!entry.owners.size) {
      if (adapter.streamWithSnapshot === entry.wrapper) adapter.streamWithSnapshot = entry.original;
      if (adapters.get(adapter) === entry) adapters.delete(adapter);
    }
  };
}
