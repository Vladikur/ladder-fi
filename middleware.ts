import { NextResponse, type NextRequest } from 'next/server';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * TZ §5: "Сервер слушает 127.0.0.1. Публичная привязка — только через явный флаг и
 * TLS." Next.js itself binds the socket (controlled by `next start -H 127.0.0.1`, see
 * package.json's start script) - this middleware is the in-app backstop: even if the
 * process ends up reachable on a non-loopback interface, requests whose Host header
 * isn't localhost are rejected unless the operator explicitly opted in.
 */
export function middleware(request: NextRequest) {
  const allowPublicBind = (process.env.ALLOW_PUBLIC_BIND ?? '').toLowerCase() === 'true';
  if (allowPublicBind) return NextResponse.next();

  const host = (request.headers.get('host') ?? '').split(':')[0] ?? '';
  if (LOCAL_HOSTS.has(host)) return NextResponse.next();

  return new NextResponse('Forbidden: this instance only accepts localhost requests. Set ALLOW_PUBLIC_BIND=true and put TLS in front of it to change this.', {
    status: 403,
  });
}

export const config = {
  matcher: '/:path*',
};
