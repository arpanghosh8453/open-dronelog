# Flight chat

Open **Chat** beside Individual and Overview. Chat reads the currently authorized profile and explains available features. It cannot edit logs, change settings, switch profiles, import files, or operate interface controls.

## Connect a provider

1. Open **Connection**. Select OpenAI or an OpenAI-compatible provider.
2. Enter your API key. For a custom provider, enter its API base URL (including `/v1` if required) and choose Responses or Chat Completions.
3. Select **Load models**, then choose a model ID from the suggestions, or enter an ID manually. The model must support streaming and function/tool calls. A model appearing in the provider's list does not guarantee tool support.
4. **Test connection** makes a small, billable synthetic tool request without flight data. Save the connection when ready.

OpenAI uses Responses. Custom providers can use either adapter. Compatibility errors identify credentials, model/API format, quota, or tool support issues without reflecting provider response bodies that might contain secrets. Chat always uses the selected model’s default reasoning behavior; no effort override is sent. New models can always be entered manually.

Requests run in the Rust backend in both desktop and Docker modes. Your messages, selected tool results, and relevant conversation history are sent to your chosen provider. API usage is billed by that provider. Providers may have their own retention policies; local storage does not mean model requests stay local.

## Questions and results

Examples:

- Compare total flight hours and median duration by drone and month, restricted to flights tagged Budapest.
- Find flights above 100 metres where a raw battery sample was below 20%, excluding a particular battery serial.
- Rank batteries by flight time this quarter; include only batteries with at least five flights.
- Show flight-duration distributions in five-minute ranges.
- Find flights with warning messages containing a particular phrase.
- How do I export a report, configure smart tags, or replay a flight?

Chat controls, status messages and result navigation follow the application language across all 14 supported languages. The model receives that language as its default response preference; users can request another language in their message. Model IDs and API format names retain their provider-defined spelling.

The analyst can make multiple tool calls for comparisons and follow-up questions. Tables, optional analytical charts and maps, CSV downloads, query details, units, timezone, and result-limit information accompany analytical results. Flight identity is carried separately from displayed columns: tables hide internal flight IDs, style equipment and serial metadata, and let you select a flight row, then double-click or press Enter to open it in the Flights tab. The open-flight button also supports touch. Aggregated rows do not navigate unless grouped by a verified individual flight. Reopening Chat retains the current conversation. CSV exports contain the visible result columns from either chart or table view; desktop uses a native save dialog.

Tables paginate locally; a limited result is not the entire matching database. Ask for an aggregate to obtain exact totals. CSV downloads export the rows in that result, not additional database rows.

All analytics use approved flight fields and structured requests compiled by Rust; model-generated SQL is never executed. Each turn includes the active profile’s schema metadata, approved tool fields, metric definitions and query examples. Schema metadata does not grant access to settings or credential values. Aliases change labels without converting units. Queries can use flights, raw telemetry joined to flights, or warnings/messages joined to flights. They support nested AND/OR/NOT filters, tags, existence of matching telemetry/messages, multiple grouping dimensions, date buckets, numerical buckets, HAVING, sorting, count/distinct count, sums, averages, min/max, medians, standard deviations and percentiles.

Flight metadata repeats on telemetry/message sources. Use distinct flight IDs for flight counts; do not sum repeated flight durations. Telemetry averages are sample-weighted, not time-weighted. Missing telemetry, including manual flights, remains missing rather than zero. Range bucket labels are lower edges; upper edges are exclusive. Date grouping and date filters use the conversation's browser timezone. Base units are metres, seconds, metres/second and Celsius; duration minutes/hours and distance kilometres are available as explicit converted fields.

Queries have a 20-second execution deadline, a maximum of 500 returned rows, and a bounded output size. A response has a five-minute deadline and at most ten model rounds. Stop cancels the model request and interrupts an active assistant database query. Only one response runs at a time per profile. Profiles have up to 50 conversations, each up to 100 messages. Delete old conversations when a limit is reached.

## API cost and usage

Each finished response has an expandable cost capsule summing all model rounds, including tool follow-ups. Reported `cost_usd` is shown directly; OpenRouter’s `usage.cost` is shown in provider credits. Otherwise the app estimates from reported input/output/cache tokens using known standard OpenAI rates or **Connection → Custom token pricing**. Prices are USD per million tokens and are scoped to the selected model. Supply both input and output prices; optional cache read/write prices are required when those token types are reported. Set prices to zero for free models. Changing model or provider clears custom rates.

The current built-in catalog covers exact GPT-6.2 Astra/Sol, GPT-6 Astra, GPT-6.1 Sol, GPT-5.2 and GPT-4o mini IDs (and explicitly listed snapshots). It was checked against [official OpenAI pricing](https://developers.openai.com/api/docs/pricing) and the [GPT-5.2](https://developers.openai.com/api/docs/models/gpt-5.2) / [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini) model pages on 2026-11-23. Unknown models, unpriced cache writes, non-standard tiers, or large-context requests require custom rates or provider-reported costs. Estimates exclude taxes and account-specific fees; the provider invoice is authoritative. OpenRouter accounting follows its [usage documentation](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

Missing or interrupted usage is marked unavailable or incomplete rather than counted as free. Older conversations without recorded pricing also show unavailable. Chat Completions requests ask for the final usage chunk with `stream_options.include_usage`; compatible providers need to support that option. Rates and usage are saved with the response, so later model changes do not reprice old answers.

## Encrypted storage and Docker operations

Connection credentials and conversation history are encrypted using AES-256-GCM with a new random nonce per write and profile-bound authenticated data. A cryptographically random 256-bit key is generated once at:

```text
<DATA_DIR>/chat/master.key
```

Encrypted profile vaults are stored alongside it as hashed `.enc` files. These files are outside the DuckDB database and normal flight backup archives. No API key is returned by the settings API, placed in browser local storage, or sent to the model as context. On Unix, the chat directory has mode `0700`; files have mode `0600`. On desktop, this directory is under the app's existing application-data directory; access also depends on the current OS user's filesystem permissions.

The existing Docker data volume persists the key and encrypted vaults across container replacement. Preserve the **entire chat directory** in an administrator's server backup. Losing or replacing `master.key` makes existing vaults unreadable. A missing key is not silently regenerated over existing profile ciphertext. Normal flight backup/restore deliberately does not transfer chat credentials/history. Deleting a profile removes its encrypted vault. Protect server backups and filesystem access: encryption at rest does not protect against an administrator/process that can read both the key and ciphertext.

Connection settings and conversations are profile-scoped and shared with other users authorized for that profile, consistent with the application's existing profile identity model. Use separate protected profiles for separate credentials. Use HTTPS when accessing a remote deployment; its operator handles the provider requests and must be trusted.

### Local model providers

Desktop permits trusted loopback/private provider endpoints. In Docker, provider requests originate inside the container: `localhost` refers to the container, not the user's browser or Docker host. Configure a reachable hostname/address for the host or another container.

Private/loopback providers in Docker require an explicit server setting:

```yaml
environment:
  - CHAT_ALLOW_PRIVATE_PROVIDERS=true
```

Leave this unset for public HTTPS providers. Enabling it allows authorized profile users to contact private network provider endpoints, so use it only on a trusted deployment. Link-local/cloud metadata, multicast and unspecified addresses remain blocked. DNS addresses are checked and pinned for each request; automatic redirects and environment proxies are disabled to avoid forwarding API credentials to another endpoint. Public providers require HTTPS.

Nginx has a dedicated `/api/chat/` proxy location with buffering disabled and a longer streaming timeout.

## Developer architecture

- `src-tauri/src/chat/analytics.rs`: transport-independent tool definitions, structured query compiler and bounded execution.
- `src-tauri/src/chat/features.rs`: curated feature guidance, separate from execution permissions.
- `src-tauri/src/chat/provider.rs`: Responses/Chat Completions streaming, discovery and connection testing.
- `src-tauri/src/chat/storage.rs`: authenticated encryption and profile vault persistence.
- `src-tauri/src/chat/mod.rs`: profile-bound conversation and tool runtime, cancellation and operations.
- `src-tauri/src/chat/web.rs`: authenticated Axum streaming transport.
- Tauri chat commands: the desktop adapter for the same operations and event stream.
- `src/components/chat/`: chat, connection and result UI using the established theme and ECharts.

The frontend normalizes HTTP SSE and Tauri channels to the same event schema. A future MCP adapter can publish `analytics::definitions()` and invoke `analytics::execute()` with its own authenticated profile context. It does not need to depend on the chat UI or model provider adapters. No MCP listener is introduced by this feature.

## Investigation tools and richer output

The shared tool registry now exposes eleven tools: `describe_data`, `query_flights`, `find_features`, plus:

| Tool | Evidence and limits |
| --- | --- |
| `search_flight_messages` | Search a literal message phrase or the `low_battery` category (including known imported low-voltage transitions). Returns distinct linked flights, an exact total and matched-message evidence with elapsed times. Optional local date boundaries and minimum altitude/duration preserve combined constraints. Categories match recorded phrases; they do not diagnose battery health. |
| `compare_cohorts` | Compare 2–6 named, filtered cohorts and up to four metrics. Returns absolute and percentage changes from the first cohort, non-null coverage, and separate charts per metric. Sums/counts can be normalized by total flight hours or kilometres. Cohorts may overlap; ratios use totals, with the denominator covering the full cohort. |
| `analyze_flight_timeline` | One flight, 1–3 numeric telemetry metrics. Up to 499 elapsed-time bins show sample means and raw min/max envelopes, with the first 50 recorded events annotated and up to 100 messages in an evidence table. Optional map shows the binned recorded route. Narrow the time range or bucket width to inspect details; bins are not original samples. Event controls and plotted points can open the verified flight at that replay timestamp. |
| `detect_anomalies` | Flight-level population mean/stddev comparisons, up to four metrics and 100 candidate flights. Without a target, candidates are the latest matching flight IDs before ranking; baseline statistics cover all matches. Supply comparable cohort/baseline filters. For a target flight, the baseline is other earlier same-aircraft-serial flights, with model fallback if serial is absent. At least three non-null baseline flights are required. Zero-variance baselines are labeled explicitly. |
| `analyze_battery_health` | Bounded flight evidence plus discharge distributions grouped by battery serial. Shows recorded discharge, voltage range, maximum temperature and cell imbalance; cycle-count scatter and per-battery box plots supplement tables. Operating conditions affect these indicators; they are not remaining-life predictions or load-corrected voltage sag. Missing serial/cycles/measurements remain unavailable. Optional `battery_limit` selects top serials by total matching flight usage before computing statistics. Exact `flights`, `known_cycle_flights` and `discharge_available_flights` counts are separate; the cycle scatter filters non-null observations before its independent 500-point cap. |
| `assess_data_quality` | Exact cohort totals and bounded per-flight evidence for actual sample counts, duplicate timestamps, largest gaps, position/battery availability, duration/span differences, and stored-value sanity counts (percentage outside 0–100, nonpositive voltage, temperatures outside -40 to 100°C). These broad sanity thresholds are investigation flags, not device operating limits or a physical-health assessment. Default gap flag is 5000 ms. Manual flights may legitimately lack telemetry. |
| `explain_metric` | Field definitions, units, aggregation weighting, null handling and caveats; internal flight IDs remain navigation metadata. |
| `build_investigation_report` | Re-executes 1–6 validated evidence queries into an inline report. Preserves filters, definitions, units, timezone, truncation, charts and verified flight links. Model commentary is labeled separately from computed evidence. |

For a selected flight, anomaly analysis also returns a baseline-deviation plot for `telemetry_metric` (battery percentage by default). Target means are aligned to historical telemetry using two-percentage-point flight-progress bins. The shaded historical envelope spans the 5th–95th percentiles of **samples**, not flight-level confidence intervals. It is hidden where fewer than three distinct baseline flights contribute. Longer/more densely sampled logs have more influence; equal normalized progress does not imply equivalent manoeuvres or environmental conditions. Missing observations remain gaps. These comparisons identify investigation leads, not established causes.

Supported chart kinds are `bar`, `line`, `donut`, `scatter`, `boxplot`, `heatmap`, `timeline`, and `map`. Scatter preserves repeated numeric x values. Box plots take five computed bounds (minimum, q1, median, q3, maximum), optionally a sixth observed value; whiskers are actual extrema, not Tukey fences. Heatmaps use x/series category pairs with one numeric measurement. Timelines use numeric elapsed milliseconds and recorded-event markers. Line/timeline plots can shade validated lower/upper columns. Maps require approved longitude/latitude fields, omit invalid coordinates, and connect telemetry routes only within a verified flight. They use the existing public basemaps; external tile access is needed for geographic context. An unavailable map retains coordinate tables and CSV export. No `analyze_locations` tool or saved-analysis workflow is included.

Multi-section results offer **Export report**, producing a standalone HTML document with escaped tables, regenerated chart images, a snapshot of a currently visible loaded map where available, methodology and query details. Use the browser's print action to create a PDF. Web exports include profile-scoped flight/replay links; open the originating deployment with that profile selected and authorized. Native desktop exports retain evidence, but do not create a desktop URI handler. Exported maps depend on a loaded map view; coordinate evidence always remains in the document. Reports contain no executable scripts or external embedded assets. CSV still exports only the selected result table, not all sections.

Tool arguments normalize JSON-encoded structural containers without changing literal predicate values or dropping constraints. A `select` array of field names expands to value selections with matching aliases; it never accepts SQL expressions. A typed predicate mistakenly supplied as root `filters` becomes `filter` only when no singular filter exists. Repairs of failed queries must retain their valid comparison/tag predicates; a broader query is rejected instead of returning an unrequested superset. Sorting accepts approved source fields for raw rows, and uniquely selected fields map to their aliases for aggregates; ambiguous aggregate sorts require an explicit alias. Filter schemas describe distinct recursive predicate shapes. Equivalent comparison symbols (=, !=, >, >=, <, <=) normalize to the named operators. An empty optional root filter is omitted; incomplete nested predicates still fail validation. Numeric comparisons reject nonnumeric date strings before execution and do not lock those invalid predicates during repairs. Calendar years use start_time ranges, never implicit year tags. Timeline/anomaly telemetry metric schemas enumerate the same supported fields as backend validation; an invalid anomaly plot metric is rejected before querying the baseline. Bucket values are explicitly enumerated; category grouping omits bucket and uses selected aliases in group_by. Invalid bucket and box-plot shapes return targeted repair instructions. describe_data includes a complete grouped quartile example.

Within a turn, identical normalized calls reuse their earlier output and do not rerun the database or render duplicate tables. Two repeated calls, four failed calls, twenty requested calls, or the last model round trigger a final answer request with tools omitted. That request must summarize available evidence and disclose gaps. The hard limits below still apply. Failed turns retain safe conversational context for a follow-up. Printed tool-call markup and assistant-internal pseudo-tool calls are suppressed across stream chunk boundaries. The runtime requests a native call once; another malformed response produces a readable failure, not a successful debug dump. Opaque Chat Completions reasoning details are preserved for tool continuation and never shown as answer text; this does not override model-default reasoning.

When `openrouter/free` returns a real native call and a resolved `:free` model, that model stays fixed for the rest of the turn. One temporary-capacity failure (429 or 503) may fall back to the saved free router. Authentication failures, request rejection and exhausted daily quotas are not retried. A malformed textual invocation may also return to the original free router for its single format repair. Explicit model selections and paid models are never substituted. OpenRouter daily free-model exhaustion has a distinct message.

Each internal database query retains the 20-second/500-row/512 KB safeguards; the complete response retains its five-minute, ten-round, 24-tool-call and 16-root-result limits. Specialist tools can run several bounded internal queries and return several evidence sections. Provider previews recursively limit multi-section evidence to the same 70 KB context budget; full results remain visible and saved locally. Model requests may need a follow-up aggregate when only preview rows were sent.

Examples:

- Compare this quarter with last quarter by total flight hours and warnings per flight hour.
- Check the data quality of my imported logs before drawing conclusions.
- Investigate the low-battery warning on this flight and plot voltage around that event.
- Compare this flight's battery percentage with earlier flights from the same aircraft, showing the historical baseline band.
- Show discharge distributions by battery and a scatter plot against cycle count.
- Build an investigation report with supporting flights, charts, filters and limitations.


## Shared analysis safeguards

Chat and external MCP clients use the same validation and result contract. Tool corrections preserve valid predicates and their boolean/message/telemetry scope, and timeline corrections retain the requested flight and elapsed-time bounds. Errors carry stable recovery codes and required constraints. Evidence tables and nested sections retain machine-readable units, coverage, null counts, explicit quality flags and per-query provenance in saved conversations. Older saved results without metadata remain readable.

Assistant SQL shares one process-wide scheduler: one active query per profile, four across chat and MCP, and up to 32 waiting queries with a 10-second queue deadline. Bulk imports, restore and flight deletion take priority over waiting assistant queries. Cancellation removes queued work and interrupts only the active assistant connection; its capacity is released when the worker exits. Specialist tools schedule each component query separately, so multi-section evidence is not one atomic snapshot. See [the MCP result contract](mcp.md#shared-validation-and-result-contract) for metadata and error details.
