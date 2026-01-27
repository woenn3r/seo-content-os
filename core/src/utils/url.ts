export function normalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    return url.toString();
  } catch {
    return input;
  }
}
