import { GatewaySession } from "js-indexus-sdk";

// The scene's layers cap their reads in src/data/scheduler.js (6 at once, by
// priority); the session's own cap is above it so that it never reorders them.
// The layers keep what they read in their own trees and byte caches: the
// session's /sets cache stays small (one data, one copy).
let session, network;
function currentSession() {
  session ??= new GatewaySession({ origin: location.origin, concurrency: 8, cacheSize: 128, contentRecords: true });
  return session;
}
export const getExperienceConfiguration = () => currentSession().configuration();
// (a thin table asks the SDK's /neighbors at most once a minute: its thinDiscoveryMs)
export const getExperienceNetwork = () =>
  (network ??= currentSession()
    .network()
    .catch((error) => {
      network = null;
      throw error;
    }));

// One SDK activity handler per JS runtime, shared by optional observers.
const activityListeners = new Set();
let activityConnection;
export function observeExperienceNetwork(listener) {
  activityListeners.add(listener);
  activityConnection ??= getExperienceNetwork()
    .then((network) =>
      network.setActivityHandler((event) => {
        for (const receive of activityListeners) receive(event);
      }),
    )
    .catch(() => {
      activityConnection = null;
    });
  return () => activityListeners.delete(listener);
}
