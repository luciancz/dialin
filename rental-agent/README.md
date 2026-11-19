# Imperial rental search

Finds 3-bed, 2+ bath long lets within a 40 minute walk of Imperial College (South Kensington) at around £4,000 pcm, scores each for niceness and value, and builds a map page.

## Run

```
python3 crawl.py        # crawl OnTheMarket, filter, route walking distance, fetch details -> data/candidates.json
python3 crawl_rm.py     # add Rightmove listings (deduplicated against the above)
python3 sheets.py       # download photos -> data/sheets/<id>.jpg contact sheets, site/thumbs/
#  niceness review: a model reads each contact sheet + data/review/<id>.txt and writes data/niceness_*.json
python3 score.py        # expected rent, value model, ranking -> data/listings.json
python3 basemap.py      # once: static OpenStreetMap base map -> site/basemap.jpg
python3 build_page.py   # -> site/index.html (publish with site/basemap.jpg and site/thumbs/)
```

Criteria, price bands, negotiation discounts and niceness weights live in `config.json`.

## Notes

- Network hosts needed: www.onthemarket.com, media.onthemarket.com, www.rightmove.co.uk, media.rightmove.co.uk, routing.openstreetmap.de, tile.openstreetmap.org.
- OnTheMarket's robots.txt disallows filter parameters, so the crawler pages through postcode-district URLs and filters locally, at about one request a second.
- OpenRent and Zoopla are not included: both serve bot challenges to automated clients.
- Walking time is routed distance at 4.8 km/h.
