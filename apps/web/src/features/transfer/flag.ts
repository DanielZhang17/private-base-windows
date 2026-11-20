/** Local history transfer is on by default (enabled 2026-11-19); set VITE_HISTORY_TRANSFER_ENABLED=false at build time to turn it off. */
export const historyTransferEnabled = import.meta.env.VITE_HISTORY_TRANSFER_ENABLED !== "false";
