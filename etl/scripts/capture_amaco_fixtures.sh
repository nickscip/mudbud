#!/usr/bin/env bash
# Capture real AMACO pages as test fixtures. Honors the 10s Crawl-delay from
# https://shop.amaco.com/robots.txt. Re-run only when the site structure changes;
# the pure parsing stages are tested against these files, never the live site.
#
# Deliberately AMACO-only rather than parameterized: the category ?limit=100 pages
# and xmlsitemap.php below are BigCommerce URL shapes, and the slug list is curated
# to cover this grammar. A second source gets its own capture_<source>_fixtures.sh
# with its own curated list, writing into tests/fixtures/<source>/.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/fixtures/amaco"
mkdir -p "$DIR"
# UA and DELAY duplicate AmacoAdapter's USER_AGENT and Politeness values — bash
# cannot import Python, so keep them in step by hand.
UA="mudbud-glaze-etl/0.1 (+https://github.com/nickscip/mudbud) contact: nscipione@blendlabsinc.com"
DELAY=10

# Chosen to cover every image pattern the filename grammar must handle:
# coats composites, layering (`over`), cone-in-filename, multi-glaze combos,
# artist credits, line color charts, and vessel forms.
PRODUCTS=(
  pc-20-blue-rutile        # coats composite + 6x6 label chip
  pc-30-temmoku            # coats composite + SM-11_CO-7_PC-30 multi-glaze combo
  pc-45-dark-green         # minimal 2-image page
  pc-72-fire-ice
  pcf-54-flux-blossom
  c-05-charcoal            # "Cone5" in filename
  sm-02-stone              # "SM-2_over_PCF-36" + JenH artist credit
  hf-127-china-blue
  lg-65-amber              # carries the LG line color chart
  o-20-bluebell            # 7 images: plate, basket, mug, label tile
  sh-22-acai-matte
  pg-55-floating-lavender  # three "PG-55overX_Cone6" layering images
  cr-61-speckled-yellow    # two "CR-61_over_X" layering images
  v-325-baby-blue-underglaze
)

fetch() {
  local url="$1" out="$2"
  printf '%s ' "$(basename "$out")"
  curl -fsS -A "$UA" --compressed --max-time 45 "$url" -o "$DIR/$out" \
    && printf 'ok %sb\n' "$(wc -c <"$DIR/$out" | tr -d ' ')" \
    || printf 'FAILED\n'
  sleep "$DELAY"
}

for slug in "${PRODUCTS[@]}"; do
  fetch "https://shop.amaco.com/$slug/" "product-$slug.html"
done

fetch "https://shop.amaco.com/glazes-underglazes/high-fire-glazes/pc-potters-choice/?limit=100" \
      "category-pc-potters-choice.html"
fetch "https://shop.amaco.com/glazes-underglazes/low-fire-glazes/lg-low-fire-gloss/?limit=100" \
      "category-lg-low-fire-gloss.html"
fetch "https://shop.amaco.com/xmlsitemap.php?type=products&page=1" "sitemap-products-1.xml"
fetch "https://shop.amaco.com/robots.txt" "robots.txt"

echo "done -> $DIR"
