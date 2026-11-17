/** Public download page. Reachable signed out, locked or signed in. */
export const CLIENTS_PATH = "/clients";

/** True for /clients and /clients/. main.tsx mounts the page without the session app for these. */
export function isClientsPath(pathname: string): boolean {
  return pathname === CLIENTS_PATH || pathname === `${CLIENTS_PATH}/`;
}
