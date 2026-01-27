export function normalizeUrl(input) {
    try {
        const url = new URL(input);
        url.hash = "";
        return url.toString();
    }
    catch {
        return input;
    }
}
