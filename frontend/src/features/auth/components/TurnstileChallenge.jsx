import React, { useEffect, useRef, useState } from "react";

let scriptPromise;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      const timeout = window.setTimeout(() => { script.remove(); reject(new Error("CAPTCHA could not load. Check your connection and retry.")); }, 15000);
      script.onload = () => {
        window.clearTimeout(timeout);
        if (window.turnstile) resolve(window.turnstile);
        else reject(new Error("CAPTCHA could not load."));
      };
      script.onerror = () => { window.clearTimeout(timeout); script.remove(); reject(new Error("CAPTCHA could not load. Check your connection and retry.")); };
      document.head.appendChild(script);
    }).catch((error) => { scriptPromise = null; throw error; });
  }
  return scriptPromise;
}

/** Explicit rendering supports modal mounts and removes widgets on cleanup. */
export default function TurnstileChallenge({ siteKey, action, onToken, resetKey = 0 }) {
  const container = useRef(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let widget;
    let api;
    callback.current("");
    setError("");
    if (!siteKey) { setError("CAPTCHA is not configured. Please contact an administrator."); return undefined; }
    loadTurnstile().then((loaded) => {
      if (!active) return;
      api = loaded;
      widget = api.render(container.current, {
        sitekey: siteKey, action, theme: "light", size: "flexible",
        callback: (token) => { if (active) { setError(""); callback.current(token); } },
        "expired-callback": () => { if (active) callback.current(""); },
        "timeout-callback": () => { if (active) callback.current(""); },
        "error-callback": () => { if (active) { callback.current(""); setError("CAPTCHA verification failed. Please retry."); } },
      });
    }).catch((failure) => { if (active) { callback.current(""); setError(failure.message); } });
    return () => { active = false; if (api && widget !== undefined) api.remove(widget); };
  }, [siteKey, action, resetKey, retry]);
  return <div className="min-w-0" aria-label="Security verification">
    <div ref={container} />
    {error ? <p role="alert" className="mt-2 text-xs text-red-600">{error}</p> : null}
    <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-2 text-xs font-semibold text-primary-700">Retry security check</button>
  </div>;
}
