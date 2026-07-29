# DataDoe Amazon Ads Fetch Windows

Verified on 2026-07-29 from the public DataDoe data-scheme specification:
`https://api.datadoe.com/api/v1/spec/data-scheme`.

## Meaning of the metadata

- **Initial** is the history DataDoe requests when a new Amazon Ads connection
  is first created. It is not evidence that an already-populated DataDoe table
  is permanently limited to that many queryable days.
- **Recurring daily/monthly/weekly** is the rolling period DataDoe re-requests
  to capture late attribution corrections. It should be treated as an upsert
  window, never as an append-only feed.
- **Continuous** has no fixed day count in the DataDoe specification. It is a
  stream/configuration dataset and starts being collected when the connection
  or stream is active; do not promise historical backfill without a separate
  DataDoe confirmation.

DataDoe's fetch-window metadata does **not** state a deletion/retention policy.
For reporting history, store each successful refresh in Supabase and re-upsert
the rolling correction window. That preserves history from the first sync even
when a new connection can initially backfill only 56 or 60 days.

## Historical performance reports

| DataDoe report | Table | Initial history | Daily correction | Monthly/weekly correction |
| --- | --- | ---: | ---: | ---: |
| Ad Performance by ASIN & Date | `amazon_ads_performance_by_child_asin_and_date` | 60 days | 21 days | 49 days monthly |
| Ad Performance by Campaign & Date | `amazon_ads_performance_by_campaign_by_date` | 56 days | 21 days | 49 days monthly |
| Ads Brand Metrics | `amazon_ads_brand_metrics` | 95 days | - | 95 days weekly |
| Keyword Targeting Performance | `amazon_ads_targeting_by_campaign_by_date` | 56 days | 21 days | 49 days monthly |
| Search Term Performance (Ads) | `amazon_ads_search_terms_by_campaign_by_date` | 60 days | 21 days | 49 days monthly |
| Ad Placement Performance (SB and SP) | `amazon_ads_placement_by_campaign_by_date` | 56 days | 28 days | 56 days monthly |
| Sponsored Brands Ad Performance | `amazon_ads_sponsored_brands_by_ad_by_date` | 56 days | 21 days | 49 days monthly |
| Ad Group Performance | `amazon_ads_by_ad_group_by_date` | 56 days | 21 days | 49 days monthly |
| Ad Purchased Products | `amazon_ads_purchased_products` | 60 days | 21 days | 49 days monthly |

## Continuous configuration and Marketing Stream reports

These have `CONTINUOUS` fetch metadata, not a stated number of historical days:

- Ad Campaigns (raw): `amazon_ads_campaigns_raw`
- Ad Groups (raw): `amazon_ads_ad_groups_raw`
- Ads (raw): `amazon_ads_ads_raw`
- Ad Targets (raw): `amazon_ads_targets_raw`
- AMS Campaigns: `amazon_ads_ams_campaigns`
- AMS Campaign Ad Groups: `amazon_ads_ams_campaign_ad_groups`
- AMS Campaign Ads: `amazon_ads_ams_campaign_ads`
- AMS Budget Usage: `amazon_ads_ams_budget_usage`
- AMS Campaign Diagnostics: `amazon_ads_ams_campaign_diagnostics`
- AMS Campaign Targets: `amazon_ads_ams_campaign_targets`
- AMS Traffic: `amazon_ads_ams_traffic`
- AMS Conversion: `amazon_ads_ams_conversion`
- AMS SB Clickstream: `amazon_ads_ams_sb_clickstream`
- AMS SB Rich Media: `amazon_ads_ams_sb_rich_media`
- AMS SP Budget Recommendations: `amazon_ads_ams_sp_budget_recommendations`
- Negative Keywords: `amazon_ads_negative_keywords`

`Sellers & Vendors Context` (`amazon_sellers_and_vendors_context`) is a
connection mapping table, not a dated performance report, and has no fetch
period.

## Upriver implementation decision

For the planned Supabase ads history:

1. Initial sync imports each enabled performance table's available initial
   history once.
2. Daily sync upserts the documented recurring daily window.
3. Monthly sync re-upserts the documented monthly/weekly window.
4. Never claim that 56 days is a permanent historical-query cap. It is the
   verified new-connection backfill window for the affected reports.

The currently configured campaign source is
`08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c`.
