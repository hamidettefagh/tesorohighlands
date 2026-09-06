// Thin ESM shim: the parser lives in api/purpleair-history.js so the hourly
// Action and the on-demand endpoint can never drift apart.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const { rowsFromHistoryPayload } = require("../api/purpleair-history.js");
