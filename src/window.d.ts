// Optional hooks a split view could set; nothing sets them in this app, so callers fall back to normal links.
declare global { interface Window { __fleetSplitNav?: (href: string) => boolean; __fleetOpenPages?: string[] } }
export {};
