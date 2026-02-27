# Workflow Context

## Flow: orangerock-market-brief

Imported from cthulu.toml task 'orangerock-market-brief'

## Your Position in the Pipeline

```
  Trigger: Every 4h (cron) -- schedule: 0 */4 * * *
    -> Source: RSS: thedefiant.io (rss) -- url: https://thedefiant.io/feed, limit: 10
    -> Source: RSS: blockworks.co (rss) -- url: https://blockworks.co/feed, limit: 10
    -> Source: RSS: www.dlnews.com (rss) -- url: https://www.dlnews.com/arc/outboundfeeds/rss/, limit: 10
    -> Source: RSS: www.theblock.co (rss) -- url: https://www.theblock.co/rss.xml, limit: 10
    -> Source: RSS: unchainedcrypto.com (rss) -- url: https://unchainedcrypto.com/feed/, limit: 10
    -> **YOU: Claude: prompts/orangerock_brief.md (claude-code)**
    -> Sink: Notion: 30aac5ee... (notion) -- database: 30aac5ee2bf980728eaefe59a03ea940
```

## Upstream Nodes (feeding data into you)

| Node | Kind | Config |
|------|------|--------|
| RSS: thedefiant.io | rss | url: https://thedefiant.io/feed, limit: 10 |
| RSS: blockworks.co | rss | url: https://blockworks.co/feed, limit: 10 |
| RSS: www.dlnews.com | rss | url: https://www.dlnews.com/arc/outboundfeeds/rss/, limit: 10 |
| RSS: www.theblock.co | rss | url: https://www.theblock.co/rss.xml, limit: 10 |
| RSS: unchainedcrypto.com | rss | url: https://unchainedcrypto.com/feed/, limit: 10 |
| Every 4h | cron | schedule: 0 */4 * * * |
| Every 4h | cron | schedule: 0 */4 * * * |
| Every 4h | cron | schedule: 0 */4 * * * |
| Every 4h | cron | schedule: 0 */4 * * * |
| Every 4h | cron | schedule: 0 */4 * * * |

## Downstream Nodes (receiving your output)

| Node | Kind | Config |
|------|------|--------|
| Notion: 30aac5ee... | notion | database: 30aac5ee2bf980728eaefe59a03ea940 |

## All Executors in This Flow

- **E01: Claude: prompts/orangerock_brief.md (this node)** -- prompt: prompts/orangerock_brief.md

## Your Configuration

- **Label**: Claude: prompts/orangerock_brief.md
- **Prompt path**: prompts/orangerock_brief.md
- **Node ID**: cc3edce8-d26e-4c56-a1fa-9a6e494901a0
