# External agent access

Open DroneLog exposes its shared read-only analytics through MCP Streamable HTTP. It supports protocol revisions 2025-11-25, 2025-06-18 and 2025-03-26, with version negotiation. The endpoint is stateless: metadata requests use JSON responses; tool calls use request-scoped SSE responses. There is no legacy `/sse` endpoint or stdio subprocess that opens the database.

## Desktop

Open **Settings → External agents**, enable the local server, and generate a named token. The endpoint defaults to `http://127.0.0.1:48765/mcp`. Set `ODL_MCP_PORT` before launching the application to select a different port if necessary. The listener only binds to IPv4 loopback; remote network clients cannot connect directly.

The application must remain running with the token's profile active and unlocked. Switching to another profile suspends access; it never redirects the token to the new profile. Disabling the local server cancels active MCP requests and closes the listener. Local enablement persists across restarts.

## Docker

Set `ODL_MCP_ENABLED=true` and recreate the container. Compose uses `${ODL_MCP_ENABLED:-false}`; leaving it unset keeps the endpoint disabled. The existing frontend proxy forwards `/mcp` to the backend without response buffering. No additional port is required.

Optionally set `ODL_MCP_PUBLIC_URL=https://logs.example.com/mcp`. This must be an absolute HTTP(S) URL ending in `/mcp`, without credentials, query parameters or fragments. It controls the endpoint displayed in Settings and permitted browser Origin. An invalid value disables MCP. Configure HTTPS at the reverse proxy for access beyond localhost. Preserve Authorization, Origin, Accept, Content-Type and MCP headers and allow responses for at least 75 seconds. A URL prefix must be rewritten to backend `/mcp` by the external proxy.

Previously paired, unexpired profiles are opened during ordinary server startup. MCP tool requests only borrow cached database handles; they never create a database or trigger migrations. If a profile could not be opened at startup, open it through the application before connecting an agent.

## Pairing and profile scope

Authenticate to the intended profile in the app, then open **Settings → External agents**. Enter a connection name and generate a token. Copy it immediately: the token is displayed once and is not recoverable from storage. Create a replacement if it is lost.

Tokens contain 256 random bits, expire after 90 days, and are stored only as SHA-256 hashes in `mcp/access.json` inside the application data directory. Each grant fixes its profile and IANA timezone at generation. Ten unexpired connections are allowed per profile. Revocation takes effect for new requests immediately and active requests within one second, before further result disclosure. Password changes/removal invalidate existing grants. Deleting a profile removes its grants, so recreating a profile with the same name does not restore access.

MCP grants are distinct from application login sessions and model-provider API keys. They are accepted only at `/mcp`. They cannot authorize normal application API operations or create/revoke other tokens. Administrative pairing operations use the existing authenticated app boundary; a protected profile requires its application session. Profiles without passwords retain the application's existing local/trusted-deployment access policy.

## Clients

Set `ODL_MCP_TOKEN` in the agent process environment to the generated token. The Settings panel provides copyable configurations. Endpoint examples below must be replaced with the value shown by your application.

Codex configuration:

```toml
[mcp_servers.open_dronelog]
url = "http://127.0.0.1:48765/mcp"
bearer_token_env_var = "ODL_MCP_TOKEN"
```

Claude Code configuration:

```json
{
  "mcpServers": {
    "open_dronelog": {
      "type": "http",
      "url": "http://127.0.0.1:48765/mcp",
      "headers": { "Authorization": "Bearer ${ODL_MCP_TOKEN}" }
    }
  }
}
```

Client references: [Codex MCP](https://developers.openai.com/codex/mcp) and [Claude Code MCP](https://code.claude.com/docs/en/mcp).

Use a private user configuration for credentials. The client must send `Authorization: Bearer <token>` on every request and accept both `application/json` and `text/event-stream`. OAuth browser login and public unauthenticated access are not provided.

## Tools and results

The server exposes `describe_data`, `query_flights`, `search_flight_messages`, `compare_cohorts`, `analyze_flight_timeline`, `detect_anomalies`, `analyze_battery_health`, `assess_data_quality`, `explain_metric`, `build_investigation_report` and `find_features`.

Tool descriptions and input schemas carry the same units, filtering, chart and read-only rules used by built-in chat. `describe_data` and the `odl://schema` resource provide the actual schema metadata, approved fields, formulas and examples. The `odl://instructions` resource provides analysis rules. Schema metadata never grants access to settings or keychain row values. `find_features` returns instructions for users; it cannot operate the interface.

Successful tool calls return `structuredContent` plus a JSON text representation. Results include profile, timezone, read-only context, units, truncation status, provenance, tables and optional chart specifications. The external agent chooses its model, produces explanations and renders results according to its client's capabilities. MCP does not run a model, expose the app's model key, save external conversations or persist analysis files. CSV files, images and interactive charts can be produced by a capable external client from the returned data; MCP does not promise native rendering in every client.

Database queries default to 500 rows, with shared limits of 20 seconds, 500 returned rows and 512 KB. A tool call has a 60-second deadline. Complete tool results, including all sections and metadata, are capped at 900 KB by the shared chat/MCP executor; oversized results return a recoverable error requesting fewer sections, rows or columns. Assistant database queries share one scheduler with built-in chat: one active query per profile and four across the process. A bounded queue admits up to 32 waiting queries, with a maximum 10-second wait. Bulk flight/telemetry/message imports, restore and flight deletion exclude assistant SQL, with waiting writers taking priority. Each specialist tool may execute several separately scheduled queries; multi-section results are not an atomic database snapshot. MCP retains 30 tool calls per minute per connection. Disconnecting a tool response stream, revoking access or disabling MCP cancels the request and interrupts its active assistant query. Cancellation never interrupts unrelated application queries.


## Shared validation and result contract

Chat and MCP use the same tool validation and correction state. Calendar boundaries, metric conversions, chart shapes and allowed fields are validated by the shared query compiler. Repairs retain valid filter predicates, including OR/NOT and message/telemetry scope, message-search dates/category/minimums, anomaly target and baseline, battery serial, cohort filters and report-section filters/HAVING, and a repaired timeline must retain its original flight and elapsed-time window. A truncated raw timeline cannot replace a complete requested window. Query-validity rules are also available through tool descriptions, `describe_data` and `odl://instructions`.

For independent external questions, supply a distinct optional `analysis_id` (1–80 ASCII letters, digits, underscores or hyphens) in tool arguments. Reuse it when correcting that analysis. If omitted, a connection uses its default analysis scope. State is isolated by bearer grant, held only in memory, bounded to 256 scopes per server, and expires after 15 idle minutes. Calls with the same ID must be sequential; a busy scope returns a recoverable error. Built-in chat scopes corrections to each user turn. Neither transport can infer omitted user intentions: callers must supply the requested constraints.

Each table and nested evidence section includes versioned `metadata`:

- `units` maps selected columns to their declared units, source fields and operations. Mixed-metric columns explicitly identify the row's unit or metric column; unknown units remain null rather than being guessed.
- `coverage` reports rows, limit/offset, truncation, null counts and section completeness. Null counts cover returned rows. `population_total` is null unless explicitly counted. `complete_result` requires a first page with no omitted trailing rows; it does not establish a complete investigation or physical sensor accuracy.
- `quality` identifies the values actually checked and any flags. Temperature, percentage and voltage checks use broad sanity thresholds; baseline shortages and missing observations are explicit. Missing checks are `not_assessed`. Values remain unchanged and no health or safety diagnosis is implied.
- `provenance` includes the validated request, source, timezone, generation time and per-query snapshot scope.

Tool failures use `isError: true` and return the same error object in `structuredContent` and JSON text content. Fields include `error`, `error_code`, `recoverable`, `retryable`, `recovery` and structured `required_constraints`. Codes distinguish invalid arguments, dropped constraints, incomplete windows, busy analysis, query timeouts, oversized results, cancellation, authorization changes, rate limits and execution failures. Retry only errors marked retryable without changing scope; otherwise follow the specified recovery action. Metadata/resource RPC failures retain JSON-RPC errors.

Password changes (including adding or removing password protection) permanently revoke the profile’s pairing tokens. Removing a password cannot reactivate a previously invalid token; pair external clients again after changing protection.
