export function reopenUrl(value) {
  let current;
  try { current = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) return null;
  // A login screen may still retain the protected destination from before import.
  // Only follow same-origin destinations; never turn this into an open redirect.
  if (/^\/(?:sign-in|signin|login)\/?$/.test(current.pathname)) {
    const redirect = current.searchParams.get('redirect');
    if (redirect) {
      try {
        const destination = new URL(redirect, current.origin);
        if (destination.origin === current.origin && !destination.username && !destination.password) {
          return destination.href;
        }
      } catch { /* Keep the current page when a redirect is malformed. */ }
    }
  }
  return current.href;
}
