const TIMEOUT_MS = 6000;

// Follow HTTP redirects on a domain and return the final hostname.
// Returns null on timeout, DNS failure, or non-HTTP domain.
export async function resolveFinalDomain(domain) {
  if (!domain) return null;
  const bare = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  for (const scheme of ["https", "http"]) {
    try {
      const res = await fetch(`${scheme}://${bare}`, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return new URL(res.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      // try next scheme
    }
  }
  return null;
}
