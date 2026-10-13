# Pinned intermediate certificates

Some agencies serve only their leaf certificate, without the intermediate that links it to a root. Browsers fetch the
missing intermediate themselves (the leaf's *Authority Information Access* "CA Issuers" URL); Node does not, and fails
with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Until 2026-10-04 the feed fetched those sources with TLS verification off.

Instead, the source's registry entry names the missing intermediate here (`tlsIntermediates`, paths relative to
`providers/`), and the fetch trusts Node's root store **plus** these files, with verification and host-name checks
on (`src/custom.ts`). An intermediate is a public CA certificate, not a secret. Each file is exactly the DER the CA
publishes at the leaf's AIA URL, converted to PEM:

| File | Subject | Issuer (root in Node's store) | Valid until | Used by | Downloaded from |
|---|---|---|---|---|---|
| `globalsign-gcc-r6-alphassl-ca-2025.crt` | GlobalSign GCC R6 AlphaSSL CA 2025 | GlobalSign Root CA - R6 | 2027-05-21 | `tmd` (`*.tmd.go.th`, the leaf until 2026-10-09; kept in case the host serves an R6 leaf again) | http://secure.globalsign.com/cacert/gsgccr6alphasslca2025.crt (2026-10-04) |
| `globalsign-gcc-r46-alphassl-ca-2025.crt` | GlobalSign GCC R46 AlphaSSL CA 2025 | GlobalSign Root R46 | 2029-06-23 | `tmd` (`*.tmd.go.th`, leaf issued 2026-10-05, valid to 2027-04-12, served since 2026-10-09: the R6 leaf was last read at 01:56 UTC, three minutes before it expired) | http://secure.globalsign.com/cacert/gsgccr46alphasslca2025.crt (2026-10-13) |
| `globalsign-rsa-ov-ssl-ca-2018.crt` | GlobalSign RSA OV SSL CA 2018 | GlobalSign Root CA - R3 | 2028-11-21 | `phivolcs` (`*.phivolcs.dost.gov.ph`, leaf valid to 2026-11-19, served by its own server 202.90.128.80; the name is on Route 53 and some resolvers get CloudFront instead, which serves an Amazon RSA 2048 M04 leaf valid to 2027-04-16 with its full chain and needs no pin: the GitHub runners reach both by turns, 2026-10-06; the pin stays for the own server) | http://secure.globalsign.com/cacert/gsrsaovsslca2018.crt (2026-10-04) |

`tests/tls-pins.test.ts` checks that each file is a CA certificate signed by a root in Node's store, that it is
not past its end date and that this table lists it, and that TMD's leaf of 2026-10-13 (`tests/fixtures/tls`) chains
through a pin.

**Leaf expiry (round 14).** Each pinned fetch keeps the leaf certificate the host presented (`src/custom.ts`
`pinnedLeaf`). `knowledge/index/provider_activity.json` keeps every leaf a source presented in the last week, one per
issuer (`tlsLeaves`): a host behind geo-DNS presents several (PHIVOLCS above), a renewal under the same issuer replaces
the old leaf at once, and an expired leaf that fails every handshake stays in view for that week, until the host
presents a valid leaf again: then it goes at once (since 2026-10-13; before, TMD's expired R6 leaf would have stood for
its R46 one until 10-16). status.json carries the one that expires first per source (`providers.<id>.tls_leaf`) and in
`tls_leaves` (`not_after`, `days_left`, `issuer`, `subject`, `seen_at`, and `leaves` when the host presented more than
one). A renewal under the same issuer needs nothing; under another issuer the source fails with this README in its
error until the new intermediate is pinned.

**Certificate failures (2026-10-13).** Every certificate error of a pinned fetch names this README in its message: a
chain error says to pin the intermediate the leaf names, any other (expired, not yet valid, another name) says the
leaf does not verify (`src/custom.ts` `PIN_HINT`, `CERT_HINT`). The aggregate keeps such a failure per source in
`provider_activity.json` (`tlsError`: the message, the streak's first and last run) until 6 hours pass without one, and
status.json lists it in `tls_errors` (`error`, `since`, `last_at`). The health workflow opens the issue "[health]
pinned certificate expiring" when a leaf has under 7 days left or a source is in `tls_errors` (`cert:<id>` in its set
line), and closes it once neither holds. Before, only the leaf kept the issue open: TMD failed every handshake from
2026-10-09, and the issue would have closed on 10-16, when its last leaf left the week's memory, with TMD still cut
off. The 6 hours ride out a host that fails by turns (geo-DNS) and still close the issue the day a pin is fixed.

**When a source starts failing with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`** (its leaf was renewed under another
intermediate), print the leaf's issuer and AIA URL, fetch that file and add it here and to the registry entry. Then
fetch the source's URL once with the new chain: TMD moved its file the same week (`/map-events.json` → 404,
`/feed/map-events.json`), and the pin alone would only have turned the TLS error into an HTTP 404.

The commands need OpenSSL 1.1.1 or later: macOS's own `openssl` is LibreSSL, which has no `-ext`, `-no-CAfile` or
`-verify_hostname` and prints its usage instead (use Homebrew's, `/opt/homebrew/bin/openssl`). Dump the roots with the
Node of `.nvmrc` (`mise exec -- node`), the one CI runs, since each Node release ships its own root store.

```bash
echo | openssl s_client -connect eq.tmd.go.th:443 -servername eq.tmd.go.th 2>/dev/null \
  | openssl x509 -noout -issuer -ext authorityInfoAccess
curl -s http://secure.globalsign.com/cacert/<name>.crt | openssl x509 -inform DER -outform PEM > providers/tls/<name>.crt
# Check the chain against Node's root store (not the system's) before pinning:
node -e 'process.stdout.write(require("tls").rootCertificates.join("\n") + "\n")' > /tmp/node-roots.pem
echo | openssl s_client -connect eq.tmd.go.th:443 -servername eq.tmd.go.th 2>/dev/null | openssl x509 > /tmp/leaf.pem
openssl verify -no-CAfile -no-CApath -CAfile /tmp/node-roots.pem -untrusted providers/tls/<name>.crt \
  -purpose sslserver -verify_hostname eq.tmd.go.th /tmp/leaf.pem
```
