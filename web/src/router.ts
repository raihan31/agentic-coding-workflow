import { useEffect, useState } from 'react';

export type Route = { name: 'projects' } | { name: 'new' } | { name: 'project'; id: string; tab: string; task?: string };

export function parseRoute(url: URL): Route {
  const match = /^\/projects\/([A-Za-z0-9-]+)$/.exec(url.pathname);
  if (match) return { name: 'project', id: match[1], tab: url.searchParams.get('tab') ?? 'overview', task: url.searchParams.get('task') ?? undefined };
  if (url.pathname === '/new') return { name: 'new' };
  return { name: 'projects' };
}

export function href(route: Route): string {
  if (route.name === 'new') return '/new';
  if (route.name === 'projects') return '/';
  const params = new URLSearchParams();
  if (route.tab !== 'overview') params.set('tab', route.tab);
  if (route.task) params.set('task', route.task);
  const qs = params.toString();
  return `/projects/${route.id}${qs ? `?${qs}` : ''}`;
}

export function navigate(to: Route | string, replace = false): void {
  const url = typeof to === 'string' ? to : href(to);
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(new URL(location.href)));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(new URL(location.href)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
