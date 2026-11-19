# Imperial rental search

Finds 3-bed, 2+ bath long lets within a 40 minute walk of Imperial College (South Kensington) at around £4,000 pcm, scores each for niceness and value, and builds a map page.

## Run

```
python3 crawl.py        # crawl OnTheMarket, filter, route walking distance, fetch details -> data/candidates.json
python3 sheets.py       # download photos -> data/sheets/<id>.jpg contact sheets, site/thumbs/
#  niceness review: a model reads each contact sheet + data/review/<id>.txt and writes data/niceness_*.json
python3 score.py        # expected rent, value model, ranking -> data/listings.json
python3 basemap.py      # once: static OpenStreetMap base map -> site/basemap.jpg
python3 build_page.py   # -> site/index.html (publish with site/basemap.jpg and site/thumbs/)
```

Criteria, price bands, negotiation discounts and niceness weights live in `config.json`.

## Notes

- Network hosts needed: www.onthemarket.com, media.onthemarket.com, routing.openstreetmap.de, tile.openstreetmap.org.
- OnTheMarket's robots.txt disallows filter parameters, so the crawler pages through postcode-district URLs and filters locally, at about one request a second.
- OpenRent is not included: it serves a CAPTCHA to automated browsers.
- Walking time is routed distance at 4.8 km/h.
