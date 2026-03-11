/* =========================================================
   DivineGames — main.js (LOCKED)
   - Loads CrazyGames by slug (?game=...)
   - Manual slug input + keyboard shortcuts
   - “Best-effort” ad/annoyance suppression (page-level)
   ========================================================= */

/* -----------------------------
   CONFIG (edit if needed)
----------------------------- */
// Your site origin (used for bookmarklet messaging / safety checks if you add any later)
const SITE_ORIGIN = `${location.protocol}//${location.host}`;

// Where CrazyGames game indexes live
const CRAZYGAMES_GAME_INDEX = (slug) =>
  `https://games.crazygames.com/en_US/${encodeURIComponent(slug)}/index.html`;

// CrazyGames SDK (gameframe loader)
const CRAZYGAMES_SDK_URL = "https://builds.crazygames.com/gameframe/v1/bundle.js";

/* -----------------------------
   DivineGames: “best-effort” ad/annoyance suppression
   Notes:
   - This can only intercept requests that go through THIS page's fetch/XHR.
   - It cannot reliably block ads inside cross-origin iframes.
----------------------------- */
(function divineAdBlocker() {
  if (typeof window === "undefined") return;

  // Keep this list as hostnames (no protocol, no paths).
  const adBlockList = [
    "doubleclick.net",
    "adservice.google.com",
    "googlesyndication.com",
    "ads.crazygames.com",
    "pagead2.googlesyndication.com",
    "securepubads.g.doubleclick.net",
    "cpx.to",
    "adnxs.com",
    "googletagmanager.com",
    "imasdk.googleapis.com",
    "google-analytics.com",
    "analytics.google.com",
    "stats.g.doubleclick.net",
  ];

  // Extra keywords that sometimes appear in element IDs/classes.
  const commonAdKeywords = [
    "ad",
    "ads",
    "adbox",
    "adunit",
    "advert",
    "advertisement",
    "banner",
    "sponsor",
    "sponsored",
    "promo",
    "promoted",
    "preroll",
    "outbrain",
    "taboola",
  ];

  function toURL(input) {
    try {
      return new URL(String(input), window.location.href);
    } catch {
      return null;
    }
  }

  function hostMatchesBlocklist(hostname) {
    if (!hostname) return false;
    const h = hostname.toLowerCase();
    return adBlockList.some((d) => h === d || h.endsWith("." + d));
  }

  function urlLooksBlocked(urlLike) {
    const u = toURL(urlLike);
    if (!u) return false;
    return hostMatchesBlocklist(u.hostname);
  }

  function safeNoopResponse() {
    // Most ad endpoints accept empty-ish JSON without breaking the page.
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- Intercept fetch (best effort) ---
  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = async function (...args) {
      try {
        const req = args[0];
        const urlLike = typeof req === "string" ? req : req?.url;
        if (urlLike && urlLooksBlocked(urlLike)) {
          console.warn("DivineGames: blocked fetch ->", urlLike);
          return safeNoopResponse();
        }
      } catch (e) {
        console.warn("DivineGames: fetch interceptor error:", e);
      }
      return originalFetch(...args);
    };
  }

  // --- Intercept XHR (best effort) ---
  if (typeof XMLHttpRequest !== "undefined") {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        if (url && urlLooksBlocked(url)) {
          console.warn("DivineGames: blocked XHR ->", url);

          // Neuter send()
          this.send = function () {
            console.warn("DivineGames: XHR send blocked ->", url);
          };

          // Try to look “completed” to naive consumers
          try {
            Object.defineProperty(this, "readyState", { value: 4 });
            Object.defineProperty(this, "status", { value: 200 });
            Object.defineProperty(this, "responseText", { value: "{}" });
            Object.defineProperty(this, "response", { value: {} });
          } catch {
            // Some browsers disallow redefining these; ignore.
          }

          // Fire callbacks if present
          try {
            if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            if (typeof this.onload === "function") this.onload();
          } catch {
            // ignore
          }
          return;
        }
      } catch (e) {
        console.warn("DivineGames: XHR interceptor error:", e);
      }
      return originalOpen.call(this, method, url, ...rest);
    };
  }

  // --- DOM cleanup (best effort) ---
  // IMPORTANT: Keep this conservative so it doesn't break the actual game container.
  function elementLooksLikeAd(el) {
    if (!el || !(el instanceof Element)) return false;

    const id = (el.id || "").toLowerCase();
    const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();

    // If it links/loads blocked hosts, it’s probably ad-related
    const src = el.getAttribute?.("src") || el.getAttribute?.("href") || el.getAttribute?.("data-src");
    if (src && urlLooksBlocked(src)) return true;

    // Keyword heuristics for id/class
    for (const k of commonAdKeywords) {
      if (id.includes(k) || cls.includes(k)) return true;
    }
    return false;
  }

  function sweepAdsOnce() {
    try {
      const candidates = document.querySelectorAll(
        "iframe, ins, script, img, video, div, section, aside, a, button"
      );

      candidates.forEach((el) => {
        // Avoid touching the launcher UI itself
        if (el.closest?.("#appShell, #gameInput, #loader, dialog#slugDialog, header.topbar")) return;

        // Avoid removing the SDK script we inject
        if (el.tagName === "SCRIPT" && el.getAttribute("src") === CRAZYGAMES_SDK_URL) return;

        if (elementLooksLikeAd(el) && el.parentNode) {
          console.warn("DivineGames: removed likely ad element:", el.tagName, el.id, el.className);
          el.remove();
        }
      });
    } catch (e) {
      console.warn("DivineGames: sweep error:", e);
    }
  }

  // Run a few times early, then stop (prevents constant fighting with the game)
  let sweeps = 0;
  const maxSweeps = 12;
  const sweepInterval = setInterval(() => {
    sweeps += 1;
    sweepAdsOnce();
    if (sweeps >= maxSweeps) clearInterval(sweepInterval);
  }, 500);

  // Light MutationObserver for late popups (still limited)
  if (typeof MutationObserver !== "undefined") {
    const obs = new MutationObserver(() => sweepAdsOnce());
    const start = () => {
      if (!document.body) return;
      obs.observe(document.body, { childList: true, subtree: true });
      // Auto-stop after 60s
      setTimeout(() => obs.disconnect(), 60_000);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
})();

/* -----------------------------
   Helpers
----------------------------- */
function $(id) {
  return document.getElementById(id);
}

function setLoaderVisible(visible, text) {
  const loader = $("loader");
  if (!loader) return;
  loader.style.display = visible ? "flex" : "none";
  if (typeof text === "string") loader.textContent = text;
}

function setInputVisible(visible) {
  const gameInput = $("gameInput");
  if (!gameInput) return;
  if (visible) gameInput.classList.add("active");
  else gameInput.classList.remove("active");
}

function getSlugFromURL() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("game");
  return slug ? slug.trim() : "";
}

function setSlugInURL(slug) {
  const u = new URL(window.location.href);
  u.search = `?game=${encodeURIComponent(slug)}`;
  window.location.href = u.toString();
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, credentials: "omit" });
  } finally {
    clearTimeout(t);
  }
}

/* -----------------------------
   Game config fetching
   (Attempts to pull "var options = {...};" from game index via CORS proxies)
----------------------------- */
async function fetchGameConfig(gameSlug) {
  const target = CRAZYGAMES_GAME_INDEX(gameSlug);

  const proxies = [
    // 1) opencors (example)
    `https://opencors.netlify.app/.netlify/functions/main?url=${encodeURIComponent(target)}`,
    // 2) corsproxy.io (requires key in some cases; keep if you have one)
    `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
    // 3) allorigins raw
    `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
  ];

  for (let i = 0; i < proxies.length; i++) {
    const url = proxies[i];
    try {
      console.log(`DivineGames: fetching config via proxy ${i + 1}:`, url.split("?")[0]);
      const res = await fetchWithTimeout(url, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();

      // Typical pattern in CrazyGames index.html
      const match = text.match(/var\s+options\s*=\s*(\{[\s\S]*?\});/);
      if (!match || !match[1]) throw new Error("Options not found");

      const options = JSON.parse(match[1]);
      return options;
    } catch (e) {
      console.warn(`DivineGames: proxy ${i + 1} failed:`, e?.message || e);
    }
  }

  return null;
}

/* -----------------------------
   SDK loading
----------------------------- */
function loadSdkScript() {
  return new Promise((resolve, reject) => {
    // Already loaded?
    if (window.Crazygames && typeof window.Crazygames.load === "function") return resolve();

    // Already injected?
    const existing = document.querySelector(`script[src="${CRAZYGAMES_SDK_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("SDK script failed")), { once: true });
      return;
    }

    const s = document.createElement("script");
    s.src = CRAZYGAMES_SDK_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("SDK script failed"));
    document.head.appendChild(s);
  });
}

/* -----------------------------
   Main load flow
----------------------------- */
async function loadGame() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const slug = getSlugFromURL();
  if (!slug) {
    setLoaderVisible(false);
    setInputVisible(true);
    return;
  }

  setInputVisible(false);
  setLoaderVisible(true, "Loading…");

  const options = await fetchGameConfig(slug);
  if (!options) {
    setLoaderVisible(
      true,
      "Loading failed: could not fetch the game configuration. Check the slug, or try again later (proxy services may be down)."
    );
    setInputVisible(true);
    return;
  }

  // Optional analytics
  try {
    if (window.posthog && typeof window.posthog.capture === "function") {
      window.posthog.capture("game selected", {
        gameslug: slug,
        gamename: options.gameName || "",
      });
    }
  } catch {
    // ignore
  }

  document.title = `${options.gameName || slug} | DivineGames`;

  try {
    await loadSdkScript();
  } catch (e) {
    console.error("DivineGames: SDK failed:", e);
    setLoaderVisible(
      true,
      "Failed to load the CrazyGames SDK script. Check your connection (or a network filter may be blocking it) and try again."
    );
    setInputVisible(true);
    return;
  }

  if (!window.Crazygames || typeof window.Crazygames.load !== "function") {
    setLoaderVisible(true, "CrazyGames SDK loaded incorrectly. Please refresh and try again.");
    setInputVisible(true);
    return;
  }

  try {
    await window.Crazygames.load(options);
    // Game is now running; remove launcher UI to avoid overlays.
    const loader = $("loader");
    const gameInput = $("gameInput");
    if (loader) loader.remove();
    if (gameInput) gameInput.remove();
  } catch (error) {
    console.error("DivineGames: Crazygames.load() failed:", error);

    let msg = `Failed to load "${options.gameName || slug}". `;
    const em = (error && error.message) ? String(error.message) : "";

    if (
      em.toLowerCase().includes("x-frame-options") ||
      em.toLowerCase().includes("refused to display") ||
      em.toLowerCase().includes("sameorigin") ||
      em.toLowerCase().includes("frame-ancestors") ||
      em.toLowerCase().includes("content-security-policy")
    ) {
      msg += "This game likely blocks embedding via security headers (CSP/X-Frame-Options). ";
    } else if (em) {
      msg += `Error: ${em}. `;
    }

    msg += "Try a different slug, or check the browser console for details.";
    setLoaderVisible(true, msg);
    setInputVisible(true);
  }
}

/* -----------------------------
   Public API (called by HTML)
----------------------------- */
function loadGameFromInput() {
  const input = $("gameSlugInput");
  if (!input) return;

  const slug = input.value.trim();
  if (!slug) {
    alert("Please enter a game slug.");
    return;
  }
  setSlugInURL(slug);
}
window.loadGameFromInput = loadGameFromInput;

/* -----------------------------
   Keyboard shortcuts
----------------------------- */
document.addEventListener("keydown", (e) => {
  // "/" focuses slug input (unless already typing in an input/textarea)
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA";

  if (e.key === "/" && !typing) {
    e.preventDefault();
    const input = $("gameSlugInput");
    if (input) input.focus();
  }

  // Enter loads game when input focused
  if (e.key === "Enter" && document.activeElement && document.activeElement.id === "gameSlugInput") {
    e.preventDefault();
    loadGameFromInput();
  }
});

/* -----------------------------
   Boot
----------------------------- */
loadGame();
