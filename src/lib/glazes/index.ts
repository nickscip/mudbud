/**
 * The glaze catalog, as the app sees it.
 *
 * Three separable jobs behind one import path: `types` is the contract with the ETL's SQL,
 * `catalog` is the wire, `grouping` and `hooks` are how a screen consumes it.
 */

export * from "./types";
export * from "./catalog";
export * from "./grouping";
export * from "./hooks";
