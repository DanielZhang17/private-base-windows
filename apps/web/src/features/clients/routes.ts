import { matchRoutes } from "react-router-dom";

/** Public download page. Reachable signed out, locked or signed in. */
export const CLIENTS_PATH = "/clients";
export const CLIENTS_RELEASES_PATH = "/clients/releases";

const CLIENTS_ROUTES = [{ path: CLIENTS_PATH }, { path: CLIENTS_RELEASES_PATH }];

export function isClientsReleasesPath(pathname: string): boolean {
  return matchRoutes(CLIENTS_ROUTES, { pathname })?.[0].route.path === CLIENTS_RELEASES_PATH;
}

/** Both public tabs mount without the session app on direct visits. */
export function isClientsPath(pathname: string): boolean {
  return matchRoutes(CLIENTS_ROUTES, { pathname }) !== null;
}
