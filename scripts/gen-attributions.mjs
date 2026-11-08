// Regenerate NOTICE + ATTRIBUTIONS.md from providers/registry.json so attribution
// never drifts from the source of truth. Run: node scripts/gen-attributions.mjs
// tests/attributions.test.ts checks the committed files equal renderAttributions(registry) byte for byte.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A licence's required statement with its link: the statement verbatim, the URL before its closing period. */
export const statementWithLink = (notice, url) => `${notice.replace(/\.$/, '')} (${url}).`;

// The Global CMT Project licenses nothing but asks to be cited: ComCat's records carry its moment magnitudes
// (magSource hrv / gcmt) and, for a few events, its preferred origin (net gcmt).
const GCMT_CITATION =
  'Global CMT Project (moment magnitudes and a few preferred origins in ComCat records): Dziewonski, A. M., T.-A. Chou and ' +
  'J. H. Woodhouse (1981), J. Geophys. Res. 86, 2825-2852, doi:10.1029/JB086iB04p02825; Ekström, G., M. Nettles and ' +
  'A. M. Dziewonski (2012), Phys. Earth Planet. Inter. 200-201, 1-9, doi:10.1016/j.pepi.2012.04.002';

/** NOTICE and ATTRIBUTIONS.md for a parsed registry ({providers: [...]}); pure. */
export function renderAttributions(reg) {
  const providers = [...reg.providers].sort((a, b) => a.priority - b.priority);
  const active = providers.filter((p) => p.active);

  // A licence that asks for a fixed statement beside the attribution (OGL – Canada, OGL v3.0 UK): registry
  // `attributionNotice`, linked to `licenseUrl`.
  const license = (p) => (p.licenseUrl ? `[${p.license}](${p.licenseUrl})` : p.license);
  const line = (p) =>
    `- **${p.name}** (\`${p.id}\`) — ${license(p)}${p.doi ? `, DOI [${p.doi}](https://doi.org/${p.doi})` : ''} — ${p.attribution}${p.attributionNotice ? `. ${p.attributionNotice}` : ''}`;
  const noticeLine = (p) =>
    `- ${p.attribution}${p.doi ? ` (DOI: ${p.doi})` : ''}${p.attributionNotice ? `. ${statementWithLink(p.attributionNotice, p.licenseUrl)}` : ''}`;

  // Catalogues a provider distributes whose rows carry their own licence (registry `catalogues`, keyed by the row's
  // `fields.net`; src/row-license.ts): ISC-GEM's solutions served by ComCat.
  const catalogues = active.flatMap((p) =>
    Object.entries(p.catalogues ?? {}).map(([net, c]) => ({ net, provider: p, ...c })),
  );
  // One line per catalogue (several nets of one catalogue share it).
  const byCatalogue = [...new Map(catalogues.map((c) => [`${c.provider.id}|${c.name}`, c])).values()].map((c) => ({
    ...c,
    nets: catalogues.filter((x) => x.provider.id === c.provider.id && x.name === c.name).map((x) => x.net),
  }));
  const doiText = (doi) => (doi ? ` (DOI: ${doi})` : '');
  const doiLink = (doi) => (doi ? `, DOI [${doi}](https://doi.org/${doi})` : '');
  const netList = (c) => c.nets.map((n) => `\`${n}\``).join(', ');

  const notice = `earthquakes-feed — attribution notice
=====================================

This dataset aggregates publicly available earthquake parameters from multiple
seismic networks. Per-event attribution is preserved in every Feature under
properties.feed.provenance[]. Please keep the attributions below when redistributing.

${active.map(noticeLine).join('\n')}

Catalogues reached through another source, whose records carry their own license
(provenance[].fields.net names the catalogue):

${byCatalogue.map((c) => `- ${c.attribution}${doiText(c.doi)}: ${c.license}, rows of ${c.provider.id} with net ${c.nets.join(' / ')}`).join('\n')}

Please also cite the ${GCMT_CITATION}.

The earthquakes-feed compilation (schema, deduplication, curation) is licensed
CDLA-Permissive-2.0. Individual observations remain under each source's own
license, recorded per record in provenance[].license.
`;

  const attributions = `# Attributions

> Generated from \`providers/registry.json\` — do not edit by hand; run \`node scripts/gen-attributions.mjs\`.

The seismic parameters in this feed are facts aggregated from the networks below.
Every Feature preserves its full source list under \`properties.feed.provenance[]\`,
each row carrying \`license\`, \`attribution\`, and \`doi\`.

## Active sources

${active.map(line).join('\n')}

## Catalogues reached through ComCat

Some rows of a source are another catalogue's solution, named by the row's \`fields.net\`. Such a row carries that
catalogue's \`license\`, \`attribution\` and \`doi\` instead of its source's (\`catalogues\` in the registry).

${byCatalogue.map((c) => `- **${c.name}** (net ${netList(c)} of \`${c.provider.id}\`) — ${c.license}${doiLink(c.doi)} — ${c.attribution}`).join('\n')}

Citation requested: ${GCMT_CITATION}.

## Configured but inactive

${providers.filter((p) => !p.active).map(line).join('\n')}

## The compilation

The selection, normalization, deduplication, and arrangement of these sources into
one feed is the original contribution of **earthquakes-feed**, licensed
[CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/). See [LICENSE](LICENSE) and
[TAKEDOWN.md](TAKEDOWN.md).
`;

  return { notice, attributions, active: active.length, inactive: providers.length - active.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = renderAttributions(JSON.parse(readFileSync('providers/registry.json', 'utf8')));
  writeFileSync('NOTICE', out.notice);
  writeFileSync('ATTRIBUTIONS.md', out.attributions);
  console.log(`wrote NOTICE + ATTRIBUTIONS.md (${out.active} active, ${out.inactive} inactive)`);
}
