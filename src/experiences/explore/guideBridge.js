// Presentation only: the embedded experience retains all tour and layer state.
const parents = new Set(["https://indexus.io", "https://www.indexus.io", "http://127.0.0.1:5193", "http://localhost:5193"]);
export function createGuideBridge({ getState, command, target = window, referrer = document.referrer }) {
  let origin = null;
  const publish = () => {
    const state = origin && getState();
    if (state) target.parent.postMessage({ type: "indexus:guide:state", state }, origin);
  };
  const receive = (event) => {
    if (target.parent === target || event.source !== target.parent || !parents.has(event.origin)) return;
    if (event.data?.type === "indexus:guide:connect") {
      origin = event.origin;
      command("connect");
      publish();
    } else if (origin === event.origin && event.data?.type === "indexus:guide:command" && ["next", "back", "close"].includes(event.data.command)) {
      command(event.data.command);
      publish();
    }
  };
  target.addEventListener("message", receive);
  try {
    const parentOrigin = new URL(referrer).origin;
    if (target.parent !== target && parents.has(parentOrigin)) target.parent.postMessage({ type: "indexus:guide:available" }, parentOrigin);
  } catch { /* Standalone or no referrer: keep the existing in-map guide. */ }
  return { active: () => origin !== null, publish, destroy() { target.removeEventListener("message", receive); } };
}
