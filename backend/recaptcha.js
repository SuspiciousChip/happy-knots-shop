export async function verifyRecaptcha(token, { secret, hostname, fetchImpl = fetch } = {}) {
  if (!secret || typeof token !== 'string' || !token || token.length > 4096) return false;
  try {
    const response = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result.success === true && result.hostname === hostname;
  } catch {
    return false;
  }
}
