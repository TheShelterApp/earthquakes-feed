// Regenerate NOTICE + ATTRIBUTIONS.md from providers/registry.json so attribution
// never drifts from the source of truth. Run: node scripts/gen-attributions.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const reg = JSON.parse(readFileSync('providers/registry.json', 'utf8'));
const providers = [...reg.providers].sort((a, b) => a.priority - b.priority);
const active = providers.filter((p) => p.active);

const line = (p) =>
  `- **${p.name}** (\`${p.id}\`) — ${p.license}${p.doi ? `, DOI [${p.doi}](https://doi.org/${p.doi})` : ''} — ${p.attribution}`;

const notice = `earthquakes-feed — attribution notice
=====================================

This dataset aggregates publicly available earthquake parameters from multiple
seismic networks. Per-event attribution is preserved in every Feature under
properties.feed.provenance[]. Please keep the attributions below when redistributing.

${active.map((p) => `- ${p.attribution}${p.doi ? ` (DOI: ${p.doi})` : ''}`).join('\n')}

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

## Configured but inactive

${providers.filter((p) => !p.active).map(line).join('\n')}

## The compilation

The selection, normalization, deduplication, and arrangement of these sources into
one feed is the original contribution of **earthquakes-feed**, licensed
[CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/). See [LICENSE](LICENSE) and
[TAKEDOWN.md](TAKEDOWN.md).
`;

writeFileSync('NOTICE', notice);
writeFileSync('ATTRIBUTIONS.md', attributions);
console.log(`wrote NOTICE + ATTRIBUTIONS.md (${active.length} active, ${providers.length - active.length} inactive)`);
