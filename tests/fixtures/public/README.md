# Minimal public test inputs

These are reviewed, reduced test contracts, not complete evidence exports, App
assets, live-page captures, translation dictionaries, or proof of UI coverage.
No installed App or signed-in browser profile is required to read these inputs.

## Native patch contract

`native-hardcoded-plan.json` contains only:

- 14 `proposals`: `id`, exact `needle`, and independent expected `replacement`
  (12 active patches and two deliberately deferred renderer boundaries).
- 31 `proposedLiteralDescriptors`: `id`, `english`, `zhTW`.
- Seven `roleLabels`: `role`, `english`, `zhTW`.

Only the small exact-match fragments needed by the patch tests are retained.
The expectations are not generated from the production patcher. Historical
consent/translation corrections remain in the existing test, applied once.
Machine identity, local paths, App hashes, timestamps, source-entry metadata,
review notes, updater observations, unrelated code, and install receipts are
excluded. Tests execute only their existing isolated, mocked snippet harnesses;
these fixtures must never be replaced with arbitrary downloaded code.

## Browser shape inputs

The five `.txt` files contain only `CTW_STATIC_SHAPES:` followed by JSON. This
small wrapper intentionally preserves the existing reader: only test input paths
changed, not assertions or parsing behavior.

| Input | Retained cases |
| --- | --- |
| `customize-public-catalog.txt` | 14 skills rows, including both landing headings |
| `plugins-public-catalog.txt` | 10 plugin rows, including both landing headings |
| `connectors-public-catalog.txt` | Seven connector rows, including its landing heading |
| `settings-shapes.txt` | Six desktop labels plus the help-link shape |
| `settings-general-labels.txt` | 11 general-settings labels |

Catalogue rows contain only `text`, `tag`, `cls`, `role`, and
`parent: {tag, cls}`, plus a fixed public route at the document level.
Desktop shapes retain only `text` and ordered `parents: [{tag, cls, role}]`.
The last parent is retained because the current test deliberately omits it when
building the synthetic DOM. General labels retain only `text`, `tag`, `cls`,
`section`, and `group`.

For `.find()` cases, the first required row is retained. All five landing-heading
rows consumed by the heading-shape regression are preserved, including
`Most installed plugins`; duplicate and unused catalogue rows are otherwise
omitted. Captured tab state, parent metadata, IDs, URLs, account values, version
values, preferences, descriptions unrelated to assertions, and arbitrary
attributes are excluded. CSS classes are structural data; the retained Tailwind
child-selector token is not HTML.

Two description bodies are newly authored synthetic text, retaining only the
short prefixes required by existing selectors. The long description exceeds
900 characters; it is not the original third-party description. Short UI
labels, public author/brand strings, and fixed installation-count sentinels
referenced by existing assertions remain unchanged. They are not current
statistics or captured private account values. In particular, no private
`Yours` contents are included.

## Running the existing tests

After installing the repository's existing development prerequisites:

```sh
node --test tests/native-patches.test.mjs
mkdir -p evidence
node tests/customize-browser.mjs
```

The browser test requires the Chrome executable at its existing macOS path,
starts **headless** with a new synthetic profile, and serves a localhost fixture.
It still writes ignored screenshots/results into a fresh `evidence/` output
directory; those generated outputs are not fixture inputs and must not be
published as part of this directory. This does not require or authorize opening
the real Claude App, logging in, installing a patch, or changing runtime data.

## Code statistics

`code-stats-shapes.json` retains only route, two leaf tag/class pairs and parent
tag/class pairs. It contains no captured usage values. The browser test supplies
synthetic counts and sample times. Dune is a lead-observed stock title, not a
user-provided or user-approved string; these tests do not prove live coverage.
