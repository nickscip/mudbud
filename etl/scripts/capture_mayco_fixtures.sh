#!/usr/bin/env bash
# Capture real Mayco responses as test fixtures. Re-run only when the site structure
# changes; the pure parsing stages are tested against these files, never the live site.
#
# Deliberately Mayco-only rather than parameterized, for the same reason
# capture_amaco_fixtures.sh is AMACO-only: every URL shape below is WooCommerce's.
#
# Note what is being captured. Mayco serves a public WooCommerce **Store API**
# (/wp-json/wc/store/v1/products, no auth), so the adapter stores JSON rather than
# HTML — the product page carries no "@type":"Product" JSON-LD and the Store API gives
# an authoritative `sku` plus the category tree the glaze filter needs. Fixtures are
# therefore .json, and each product is fetched through `?slug=` so the stored body is
# byte-identical to what the Fetcher will record for that URL.
#
# robots.txt permits all of this: the Yoast block is an empty `Disallow:`, /wp-json/ is
# not listed, and no Crawl-delay is declared. DELAY below is self-imposed — see F14.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/fixtures/mayco"
mkdir -p "$DIR"
# UA and DELAY duplicate MaycoAdapter's USER_AGENT and Politeness values — bash cannot
# import Python, so keep them in step by hand.
UA="mudbud-glaze-etl/0.1 (+https://github.com/nickscip/mudbud) contact: nscipione@blendlabsinc.com"
DELAY=10
SITE="https://www.maycocolors.com"
API="$SITE/wp-json/wc/store/v1/products"

fetch() {
  local url="$1" out="$2"
  printf '%s ' "$out"
  curl -fsS -A "$UA" --compressed --max-time 45 "$url" -o "$DIR/$out" \
    && printf 'ok %sb\n' "$(wc -c <"$DIR/$out" | tr -d ' ')" \
    || printf 'FAILED\n'
  sleep "$DELAY"
}

# Products that must parse to the full basics (code, line, image, price). Each is here
# for a property the parser or the grammar has to get right.
PRODUCTS=(
  sw214-micro-pearl                    # 16 images: 1234coats composite, _over_, _under_,
                                       # clay-body alt text, soda. Undashed slug, dashed SKU.
  sw-197-fossil-rock                   # dashed slug; price_range (min != max); not-dinnerware icon
  sc-104-grape-expectations            # Stroke & Coat — trademark glyph in the line name
  cg-999-jazz-notes                    # Jungle Gems
  sp-288-speckled-tu-tu-tango          # Speckled Stroke & Coat
  fn-219-lustre-green                  # FN code in the *Elements* line — proves code prefix
                                       # is not the line. Also cl-acmi AND ap-acmi together.
  ug-208-dragon-red                    # attribute value is a raw <img src=...> tag
  ug-236-grey                          # dinnerware-safe-with-clear-glaze icon
  el-212-spotted-walnut                # Elements, cl-acmi seal
  pb001-pure-brilliance-clear-brushing # plain-text "Dinnerware Safe" + "Food Safe"
  fd258-pure-white                     # French Dimensions; _over_ filenames; text "Not Dinnerware Safe"
  rk-107-oil-slick                     # Raku — Mayco states no cone for this line
  lilac                                # EZ112: the slug carries no code at all, so the SKU
                                       # is the only source of truth for `code`
)

for slug in "${PRODUCTS[@]}"; do
  fetch "$API?slug=$slug" "product-$slug.json"
done

# Deliberately *not* named product-*.json: the source-agnostic contract test requires
# every product-*.json to yield a code, a line, an image and a price, and each of these
# is here precisely because it does not.
fetch "$API?slug=sw229-mood-ring" "zeroprice-sw229-mood-ring.json"     # prices.price == "0"
fetch "$API?slug=cr901-waterfall" "noline-cr901-waterfall.json"        # no fired-child category
fetch "$API?slug=sp-kt2p-speckled-stroke-coat-kit-2-pints" \
      "nonglaze-sp-kt2p-kit.json"                                      # product-kits, filtered out

# Two fetches of the same product, for the volatile-pattern measurement (F6).
fetch "$API?slug=sw-197-fossil-rock" "volatile-sw-197-fossil-rock-fetch-a.json"
fetch "$API?slug=sw-197-fossil-rock" "volatile-sw-197-fossil-rock-fetch-b.json"

# Discovery inputs. The allowlist page is captured at per_page=20 rather than the 100
# discovery actually uses: the response shape is identical and a 100-item page is 1.6MB,
# which is not worth checking in to prove the same parsing.
fetch "$API?category=98&per_page=20&page=1" "fired-allowlist-page-1.json"
fetch "$SITE/sitemap_index.xml" "sitemap-index.xml"
fetch "$SITE/product-sitemap.xml" "sitemap-products-1.xml"
fetch "$SITE/product-sitemap2.xml" "sitemap-products-2.xml"
fetch "$SITE/robots.txt" "robots.txt"

echo "done -> $DIR"
