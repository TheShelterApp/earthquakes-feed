// Types for scripts/gen-attributions.mjs (the tests import it).
import type { ProviderConfig } from '../src/types.js';

/** A licence's required statement with its link: the statement verbatim, the URL before its closing period. */
export declare function statementWithLink(notice: string, url: string): string;
/** NOTICE and ATTRIBUTIONS.md for a parsed registry; pure. */
export declare function renderAttributions(reg: { providers: ProviderConfig[] }): {
  notice: string;
  attributions: string;
  active: number;
  inactive: number;
};
