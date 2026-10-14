// Dry-run clock (scripts/phase2/dryrun.sh): with FAKE_NOW_MS set, Date.now() and `new Date()` start there and run at real
// speed. Loaded with `node --import ./scripts/phase2/fake-clock.mjs --import tsx <script>`.
const fake = Number(process.env.FAKE_NOW_MS);
if (Number.isFinite(fake) && fake > 0) {
  const RealDate = Date;
  const offset = fake - RealDate.now();
  class FakeDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(RealDate.now() + offset);
      else super(...a);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = FakeDate;
}
