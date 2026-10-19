/** Copy text via the async clipboard API; falls back to the legacy
 * execCommand path on insecure origins (e.g. an http:// LAN hub) where
 * navigator.clipboard is absent. False when both paths are unavailable
 * or denied. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied/unavailable — try the legacy path before giving up.
  }
  try {
    if (typeof document === "undefined" || typeof document.execCommand !== "function") {
      return false;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
