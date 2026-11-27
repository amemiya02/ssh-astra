/** Returns the exact destination to show and open, or null for an unsafe Terminal link. */
export function terminalLinkDestination(uri: string): string | null {
  if (/[\\\p{White_Space}\p{Cc}\p{Cs}]/u.test(uri)) return null;

  try {
    // Decoding here also catches malformed escapes and escaped direction controls.
    if (/\p{Bidi_Control}/u.test(decodeURI(uri))) return null;

    const url = new URL(uri);
    if (url.protocol === "http:" || url.protocol === "https:") {
      // Reject missing or extra slashes that URL would silently repair.
      return /^https?:\/\/[^/]/i.test(uri) ? url.href : null;
    }
    if (url.protocol === "mailto:" && !/^mailto:\//i.test(uri)) return url.href;
  } catch {
    // Malformed URL or percent encoding.
  }
  return null;
}
