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
| `globalsign-gcc-r6-alphassl-ca-2025.crt` | GlobalSign GCC R6 AlphaSSL CA 2025 | GlobalSign Root CA - R6 | 2027-05-21 | `tmd` (`*.tmd.go.th`, leaf valid to 2026-10-09) | http://secure.globalsign.com/cacert/gsgccr6alphasslca2025.crt (2026-10-04) |
| `globalsign-rsa-ov-ssl-ca-2018.crt` | GlobalSign RSA OV SSL CA 2018 | GlobalSign Root CA - R3 | 2028-11-21 | `phivolcs` (`*.phivolcs.dost.gov.ph`, leaf valid to 2026-11-19) | http://secure.globalsign.com/cacert/gsrsaovsslca2018.crt (2026-10-04) |

`tests/tls-pins.test.ts` checks that each file is a CA certificate signed by a root in Node's store and that it is
not past its end date.

**When a source starts failing with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`** (its leaf was renewed under another
intermediate), print the leaf's issuer and AIA URL, fetch that file and add it here and to the registry entry:

```bash
echo | openssl s_client -connect eq.tmd.go.th:443 -servername eq.tmd.go.th 2>/dev/null \
  | openssl x509 -noout -issuer -ext authorityInfoAccess
curl -s http://secure.globalsign.com/cacert/<name>.crt | openssl x509 -inform DER -outform PEM > providers/tls/<name>.crt
```
