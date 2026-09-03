/**
 * The single bigint-aware JSON serializer for API responses (TZ §4: "Единый
 * сериализатор bigint в JSON"). bigints become decimal strings - the client only ever
 * displays these values or echoes user-typed decimal strings back in a request, it
 * never needs to reconstruct a real bigint from a response, so a plain string (no
 * type-tag wrapper) is sufficient and keeps the payload readable.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data, bigintReplacer);
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(body, { ...init, headers });
}
