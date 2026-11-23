//! Bounded, query-backed investigations. Calculations stay in Rust/DuckDB, never in model SQL.
use super::analytics::{self, Chart, QueryResult};
use crate::database::Database;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const DERIVED_FIELDS: &[&str] = &[
    "telemetry_sample_count",
    "telemetry_span_ms",
    "telemetry_max_gap_ms",
    "telemetry_duplicate_count",
    "telemetry_position_count",
    "telemetry_battery_count",
    "battery_start_percent",
    "battery_end_percent",
    "battery_drop_percent",
    "battery_drain_per_minute",
    "battery_voltage_range",
    "battery_min_voltage",
    "battery_max_temperature",
    "battery_min_temperature",
    "battery_temperature_outlier_count",
    "battery_percent_out_of_range_count",
    "battery_nonpositive_voltage_count",
    "battery_max_cell_imbalance",
];
pub fn derived_field(name: &str) -> Option<String> {
    let expression = match name {
        "telemetry_sample_count" => "count(*)",
        "telemetry_span_ms" => "max(timestamp_ms)-min(timestamp_ms)",
        "telemetry_duplicate_count" => "count(*)-count(DISTINCT timestamp_ms)",
        "telemetry_position_count" => "count(*) FILTER (WHERE latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180 AND NOT(latitude=0 AND longitude=0))",
        "telemetry_battery_count" => "count(battery_percent)",
        "battery_start_percent" => "arg_min(battery_percent,timestamp_ms)",
        "battery_end_percent" => "arg_max(battery_percent,timestamp_ms)",
        "battery_drop_percent" => "arg_min(battery_percent,timestamp_ms)-arg_max(battery_percent,timestamp_ms)",
        "battery_drain_per_minute" => "(arg_min(battery_percent,timestamp_ms)-arg_max(battery_percent,timestamp_ms))*60000.0/nullif(max(timestamp_ms) FILTER (WHERE battery_percent IS NOT NULL)-min(timestamp_ms) FILTER (WHERE battery_percent IS NOT NULL),0)",
        "battery_voltage_range" => "max(battery_voltage)-min(battery_voltage)",
        "battery_min_voltage" => "min(battery_voltage)",
        "battery_max_temperature" => "max(battery_temp)",
        "battery_min_temperature" => "min(battery_temp)",
        "battery_temperature_outlier_count" => "count(*) FILTER (WHERE battery_temp < -40 OR battery_temp > 100)",
        "battery_percent_out_of_range_count" => "count(*) FILTER (WHERE battery_percent < 0 OR battery_percent > 100)",
        "battery_nonpositive_voltage_count" => "count(*) FILTER (WHERE battery_voltage <= 0)",
        "battery_max_cell_imbalance" => "max(list_max(try_cast(cell_voltages AS DOUBLE[]))-list_min(try_cast(cell_voltages AS DOUBLE[])))",
        "telemetry_max_gap_ms" => return Some("(SELECT max(gap_ms) FROM (SELECT timestamp_ms-lag(timestamp_ms) OVER (ORDER BY timestamp_ms) AS gap_ms FROM telemetry WHERE flight_id=f.id) gaps)".into()),
        _ => return None,
    };
    Some(format!(
        "(SELECT {expression} FROM telemetry WHERE flight_id=f.id)"
    ))
}
fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
pub fn definitions(query: &Value) -> Vec<Value> {
    let filter = json!({"$ref":"#/$defs/filter"});
    let mut tools = vec![
        ("compare_cohorts", "Compare 2–6 explicitly named flight cohorts. Compute totals/statistics and changes from the first cohort, optionally per flight hour or km. Ratios use sums over all matching flights, never average-of-ratios. Overlapping cohorts are allowed and disclosed.", object(json!({"cohorts":{"type":"array","minItems":2,"maxItems":6,"items":object(json!({"name":{"type":"string","maxLength":80},"filter":filter}), &["name","filter"])},"metrics":{"type":"array","minItems":1,"maxItems":4,"items":object(json!({"field":{"type":"string"},"op":{"type":"string","enum":["sum","avg","median","min","max","count","count_distinct","percentile"]},"percentile":{"type":"number"},"normalize":{"type":"string","enum":["none","flight_hour","km"]}}), &["field","op"])}}), &["cohorts","metrics"])),
        ("analyze_flight_timeline", "Analyze one flight using elapsed milliseconds, bounded time bins and raw-warning annotations. Includes mean/min/max envelopes; use a narrow start/end range for closer inspection. Optional map shows the bounded recorded route, not location analysis.", object(json!({"flight_id":{"type":"integer","minimum":1},"metrics":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"string","enum":NUMERIC_TELEMETRY}},"start_ms":{"type":"number","minimum":0},"end_ms":{"type":"number","minimum":0},"bucket_ms":{"type":"number","minimum":1},"include_map":{"type":"boolean"}}), &["flight_id","metrics"])),
        ("detect_anomalies", "Find deviations using population mean/stddev of flight-level metrics and a declared baseline. With flight_id, defaults to other earlier flights of the same aircraft (model fallback), excludes target and plots one telemetry metric against historical 5–95% bands at normalized flight progress. At least 3 non-null baseline flights are required. Not a causal or safety diagnosis. Candidate list is bounded; baseline aggregates cover all matches.", object(json!({"flight_id":{"type":"integer","minimum":1},"filter":filter,"baseline_filter":filter,"metrics":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"string"}},"telemetry_metric":{"type":"string","enum":NUMERIC_TELEMETRY,"description":"Raw telemetry field for the baseline plot, e.g. telemetry_altitude. Flight summary metrics such as max_altitude are not raw telemetry fields."},"threshold":{"type":"number","minimum":1,"maximum":10},"limit":{"type":"integer","minimum":1,"maximum":100}}), &[])),
        ("analyze_battery_health", "Use FIRST for battery comparisons with discharge distributions and cycle-count scatter plots. Returns exact per-serial total flights, known-cycle and discharge-available counts plus charts. battery_limit selects the most-used N serials by all matching flights; limit bounds the recent-flight scatter table only. Compares recorded discharge, voltage range, temperature and cell imbalance. These are operating-condition-dependent indicators, not a remaining-life estimate or load-corrected voltage sag.", object(json!({"filter":filter,"battery_serial":{"type":"string","maxLength":200},"battery_limit":{"type":"integer","minimum":1,"maximum":100},"limit":{"type":"integer","minimum":1,"maximum":500}}), &[])),
        ("assess_data_quality", "Assess flight/telemetry completeness, timestamp gaps and duplicates, position/battery coverage, duration/span mismatch and exact counts of stored battery percentages outside 0–100, nonpositive voltage, and temperatures outside a broad -40 to 100 Celsius sanity band. Flags suggest investigation of decoding/units; they are not operating limits or physical battery-health diagnoses. Exact summary over all matches plus bounded per-flight evidence. Manual flights legitimately have no telemetry. Does not alter data.", object(json!({"filter":filter,"gap_ms":{"type":"number","minimum":1},"limit":{"type":"integer","minimum":1,"maximum":500}}), &[])),
        ("explain_metric", "Explain field units, calculation, weighting and limitations. Use describe_data for supported identifiers.", object(json!({"metric":{"type":"string","maxLength":100}}), &["metric"])),
        ("build_investigation_report", "Build an exportable report by executing 1–6 validated evidence queries. Each section retains filters, units, provenance, charts and flight links. Interpretations are explicitly labeled as model commentary, not verified calculations. Does not save a reusable analysis.", object(json!({"title":{"type":"string","maxLength":160},"sections":{"type":"array","minItems":1,"maxItems":6,"items":object(json!({"query":query,"interpretation":{"type":"string","maxLength":2000}}), &["query"])}}), &["title","sections"])),
    ];
    tools
        .drain(..)
        .map(|(name, description, mut parameters)| {
            parameters["$defs"] = query["$defs"].clone();
            json!({"name":name,"description":description,"parameters":parameters})
        })
        .collect()
}
fn cmp(field: &str, op: &str, value: Value) -> Value {
    json!({"kind":"compare","field":field,"op":op,"value":value})
}
fn all(filters: Vec<Value>) -> Value {
    json!({"kind":"all","filters":filters.into_iter().filter(|v| !v.is_null()).collect::<Vec<_>>()})
}
fn selection(field: &str, op: &str, alias: &str) -> Value {
    json!({"field":field,"op":op,"alias":alias})
}
async fn run(db: Arc<Database>, q: Value, zone: &str) -> Result<QueryResult, String> {
    analytics::query(
        db,
        serde_json::from_value(q).map_err(|e| format!("Invalid investigation query: {e}"))?,
        zone.into(),
    )
    .await
}
fn result(
    title: &str,
    columns: &[&str],
    rows: Vec<Value>,
    request: Value,
    zone: &str,
    note: &str,
) -> QueryResult {
    QueryResult {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.into(),
        columns: columns.iter().map(|s| s.to_string()).collect(),
        row_flight_ids: vec![None; rows.len()],
        column_meta: Default::default(),
        rows,
        truncated: false,
        source: "flights".into(),
        timezone: zone.into(),
        request,
        chart: None,
        note: note.into(),
        sections: vec![],
    }
}
fn chart(kind: &str, x: &str, ys: &[&str], series: Option<&str>) -> Chart {
    Chart {
        kind: kind.into(),
        x: x.into(),
        y: ys.iter().map(|s| s.to_string()).collect(),
        series: series.map(String::from),
        annotations: vec![],
        band: None,
    }
}
fn num(row: &Value, field: &str) -> Option<f64> {
    row[field].as_f64().filter(|n| n.is_finite())
}
fn finite(n: Option<f64>) -> Value {
    n.filter(|n| n.is_finite())
        .map_or(Value::Null, |n| json!(n))
}
fn positive_id(id: i64) -> Result<(), String> {
    if id <= 0 {
        Err("flight_id must be positive".into())
    } else {
        Ok(())
    }
}
fn limit(n: usize, max: usize) -> Result<(), String> {
    if n == 0 || n > max {
        Err(format!("limit must be 1–{max}"))
    } else {
        Ok(())
    }
}
fn default_limit() -> usize {
    100
}
fn default_threshold() -> f64 {
    2.5
}
fn default_gap() -> f64 {
    5000.0
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Metric {
    field: String,
    op: String,
    #[serde(default)]
    percentile: Option<f64>,
    #[serde(default)]
    normalize: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cohort {
    name: String,
    filter: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Compare {
    cohorts: Vec<Cohort>,
    metrics: Vec<Metric>,
}
pub(super) fn metric_unit(metric: &str) -> &'static str {
    match metric{"duration_secs"=>"seconds","duration_minutes"=>"minutes","duration_hours"=>"hours","distance_km"=>"kilometres","total_distance"|"max_altitude"|"telemetry_height"|"telemetry_altitude"|"telemetry_altitude_abs"|"telemetry_vps_height"=>"metres","max_speed"|"telemetry_speed"|"telemetry_velocity_x"|"telemetry_velocity_y"|"telemetry_velocity_z"=>"metres/second","home_lat"|"home_lon"|"telemetry_latitude"|"telemetry_longitude"|"telemetry_pitch"|"telemetry_roll"|"telemetry_yaw"|"telemetry_gimbal_pitch"|"telemetry_gimbal_roll"|"telemetry_gimbal_yaw"=>"degrees","battery_drain_per_minute"=>"percentage points/minute","battery_max_temperature"|"battery_min_temperature"|"telemetry_battery_temp"=>"Celsius","battery_temperature_outlier_count"|"battery_percent_out_of_range_count"|"battery_nonpositive_voltage_count"=>"count",m if m.contains("voltage")||m.contains("imbalance")=>"volts",m if m.ends_with("_ms")=>"milliseconds",m if m.contains("percent")||m.contains("progress")=>"percent / percentage points",m if m.contains("count")||m=="cycle_count"||m=="telemetry_satellites"=>"count",_=>"See field definition; identifiers/categories have no numeric unit; signal values retain parser-native scales"}
}

fn metric_key(m: &Metric) -> String {
    let operation = if m.op == "percentile" {
        format!(
            "percentile:{}",
            m.percentile.map(|p| p.to_string()).unwrap_or_default()
        )
    } else {
        m.op.clone()
    };
    format!(
        "{}({}) / {}",
        operation,
        m.field,
        m.normalize.as_deref().unwrap_or("none")
    )
}
async fn compare(
    db: Arc<Database>,
    a: Compare,
    request: Value,
    zone: &str,
) -> Result<QueryResult, String> {
    if !(2..=6).contains(&a.cohorts.len()) || !(1..=4).contains(&a.metrics.len()) {
        return Err("Use 2–6 cohorts and 1–4 metrics".into());
    }
    let mut unique = std::collections::HashSet::new();
    if a.cohorts.iter().any(|c| !unique.insert(c.name.clone())) {
        return Err("Cohort names must be unique".into());
    }
    unique.clear();
    if a.metrics.iter().any(|m| !unique.insert(metric_key(m))) {
        return Err("Comparison metrics must be unique".into());
    }
    let mut rows = vec![];
    let mut references = vec![None; a.metrics.len()];
    for (ci, c) in a.cohorts.iter().enumerate() {
        if c.name.trim().is_empty() || c.name.len() > 80 {
            return Err("Cohort name must be 1–80 characters".into());
        }
        for (mi, m) in a.metrics.iter().enumerate() {
            if ![
                "sum",
                "avg",
                "median",
                "min",
                "max",
                "count",
                "count_distinct",
                "percentile",
            ]
            .contains(&m.op.as_str())
            {
                return Err("Unsupported comparison statistic".into());
            }
            let normalize = m.normalize.as_deref().unwrap_or("none");
            if !["none", "flight_hour", "km"].contains(&normalize)
                || (normalize != "none"
                    && !["sum", "count", "count_distinct"].contains(&m.op.as_str()))
            {
                return Err("Normalize only sums/counts by none, flight_hour or km".into());
            }
            let mut sel = selection(&m.field, &m.op, "numerator");
            if let Some(p) = m.percentile {
                sel["percentile"] = json!(p)
            }
            let denominator = if normalize == "km" {
                "distance_km"
            } else {
                "duration_hours"
            };
            let q=run(db.clone(),json!({"select":[sel,selection(denominator,"sum","denominator"),selection("*","count","flights"),selection(if m.field=="*"{"id"}else{&m.field},"count","available")],"filter":c.filter}),zone).await?;
            let r = &q.rows[0];
            let value = num(r, "numerator").and_then(|n| {
                if normalize == "none" {
                    Some(n)
                } else {
                    num(r, "denominator").filter(|d| *d > 0.0).map(|d| n / d)
                }
            });
            if ci == 0 {
                references[mi] = value
            };
            let reference = references[mi];
            rows.push(json!({"cohort":c.name,"metric":metric_key(m),"unit":if ["count","count_distinct"].contains(&m.op.as_str()) { "count".to_string() } else { metric_unit(&m.field).to_string() } + if normalize=="none" { "" } else if normalize=="km" { "/kilometre" } else { "/flight hour" },"value":finite(value),"reference":finite(reference),"change":finite(value.zip(reference).map(|(v,b)|v-b)),"change_percent":finite(value.zip(reference).filter(|(_,b)|*b!=0.0).map(|(v,b)|100.0*(v-b)/b.abs())),"flights":r["flights"],"available":r["available"],"denominator":if normalize=="none"{Value::Null}else{r["denominator"].clone()}}));
        }
    }
    let mut r=result("Cohort comparison", &["cohort","metric","unit","value","reference","change","change_percent","flights","available","denominator"],rows,request,zone,"Reference is the first cohort. Cohorts may overlap; differences are descriptive, not causal. Null denominators/zero references produce null ratios. Normalized rates are ratios of totals; denominators cover the full cohort even when the numerator field is missing for some flights. Non-null available counts show metric coverage. Different metric units must not be compared directly.");
    // Separate metrics avoid mixing unrelated units on a shared value axis.
    for m in &a.metrics {
        let key = metric_key(m);
        let mut section = result(
            &key,
            &["cohort", "value", "unit"],
            r.rows
                .iter()
                .filter(|v| v["metric"] == key)
                .cloned()
                .collect(),
            r.request.clone(),
            zone,
            &r.note,
        );
        section.column_meta.insert(
            "value".into(),
            super::analytics::ColumnMeta {
                field: if m.normalize.as_deref().unwrap_or("none") == "none" {
                    m.field.clone()
                } else {
                    format!("{}__per_{}", m.field, m.normalize.as_deref().unwrap())
                },
                op: m.op.clone(),
                bucket: None,
            },
        );
        section.chart = Some(chart("bar", "cohort", &["value"], None));
        r.sections.push(section)
    }
    Ok(r)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Timeline {
    flight_id: i64,
    metrics: Vec<String>,
    #[serde(default)]
    start_ms: Option<f64>,
    #[serde(default)]
    end_ms: Option<f64>,
    #[serde(default)]
    bucket_ms: Option<f64>,
    #[serde(default)]
    include_map: bool,
}
async fn timeline(
    db: Arc<Database>,
    a: Timeline,
    request: Value,
    zone: &str,
) -> Result<QueryResult, String> {
    positive_id(a.flight_id)?;
    if a.metrics.is_empty() || a.metrics.len() > 3 {
        return Err("Select 1–3 telemetry metrics".into());
    }
    for m in &a.metrics {
        numeric_telemetry(m)?;
    }
    let stats=run(db.clone(),json!({"source":"telemetry","select":[selection("telemetry_timestamp_ms","min","first"),selection("telemetry_timestamp_ms","max","last")],"filter":cmp("id","eq",json!(a.flight_id))}),zone).await?;
    let first = num(&stats.rows[0], "first").ok_or("Flight has no recorded telemetry")?;
    let last = num(&stats.rows[0], "last").unwrap_or(first);
    let start = a.start_ms.unwrap_or(first);
    let end = a.end_ms.unwrap_or(last);
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end < start {
        return Err("Invalid elapsed-time range".into());
    }
    let width = a
        .bucket_ms
        .unwrap_or(((end - start) / 450.0).ceil().max(1.0));
    if !width.is_finite() || width < 1.0 || ((end - start) / width) > 498.0 {
        return Err("Use at most 499 time bins; increase bucket_ms or narrow the range".into());
    }
    let filter = all(vec![
        cmp("id", "eq", json!(a.flight_id)),
        cmp("telemetry_timestamp_ms", "gte", json!(start)),
        cmp("telemetry_timestamp_ms", "lte", json!(end)),
    ]);
    let mut sections = vec![];
    let messages=run(db.clone(),json!({"source":"messages","select":[selection("message_timestamp_ms","value","elapsed_ms"),selection("message_type","value","type"),selection("message_text","value","message")],"filter":all(vec![cmp("id","eq",json!(a.flight_id)),cmp("message_timestamp_ms","gte",json!(start)),cmp("message_timestamp_ms","lte",json!(end))]),"order_by":[{"field":"elapsed_ms"}],"limit":100,"title":"Recorded events"}),zone).await?;
    for metric in &a.metrics {
        let mut r=run(db.clone(),json!({"source":"telemetry","select":[{"field":"telemetry_timestamp_ms","alias":"elapsed_ms","bucket":"range","width":width},selection(metric,"avg","mean"),selection(metric,"min","minimum"),selection(metric,"max","maximum"),selection(metric,"count","samples")],"filter":filter,"group_by":["elapsed_ms"],"order_by":[{"field":"elapsed_ms"}],"limit":500,"title":metric}),zone).await?;
        let mut spec = chart(
            "timeline",
            "elapsed_ms",
            &["mean", "minimum", "maximum"],
            None,
        );
        spec.band = Some(super::analytics::Band {
            lower: "minimum".into(),
            upper: "maximum".into(),
        });
        spec.annotations = messages
            .rows
            .iter()
            .take(50)
            .filter_map(|row| {
                num(row, "elapsed_ms").map(|x| super::analytics::Annotation {
                    x,
                    label: format!(
                        "{}: {}",
                        row["type"].as_str().unwrap_or(""),
                        row["message"].as_str().unwrap_or("")
                    )
                    .chars()
                    .take(300)
                    .collect(),
                })
            })
            .collect();
        r.chart = Some(spec);
        r.row_flight_ids = vec![Some(a.flight_id); r.rows.len()];
        r.note=format!("Elapsed milliseconds from flight start; bins are {width} ms. Mean is sample-weighted; shaded envelope retains raw sample min/max per bin. Missing samples are not interpolated. First 50 events annotated; event table holds up to 100. Metric: {metric}. {}",r.note);
        sections.push(r);
    }
    if a.include_map {
        let mut map=run(db.clone(),json!({"source":"telemetry","select":[{"field":"telemetry_timestamp_ms","alias":"elapsed_ms","bucket":"range","width":width},selection("telemetry_longitude","avg","longitude"),selection("telemetry_latitude","avg","latitude")],"filter":all(vec![filter.clone(),valid_position()]),"group_by":["elapsed_ms"],"order_by":[{"field":"elapsed_ms"}],"limit":500,"title":"Recorded route (binned)"}),zone).await?;
        map.chart = Some(chart("map", "longitude", &["latitude"], None));
        map.row_flight_ids = vec![Some(a.flight_id); map.rows.len()];
        map.note="Route points are mean recorded coordinates per time bin; they approximate the path, not a location investigation. Gaps and averaging can omit manoeuvres. Map tiles use the app's configured public basemap.".into();
        sections.push(map);
    }
    let mut root=result("Flight timeline",&["metric","start_ms","end_ms","bucket_ms"],a.metrics.iter().map(|m|json!({"metric":m,"start_ms":start,"end_ms":end,"bucket_ms":width})).collect(),request,zone,"Review telemetry and recorded messages together; temporal correlation does not establish cause. Plotted values retain their metric units.");
    root.row_flight_ids = vec![Some(a.flight_id); root.rows.len()];
    root.truncated = messages.truncated;
    sections.push(messages);
    root.sections = sections;
    Ok(root)
}
fn valid_position() -> Value {
    all(vec![
        cmp("telemetry_latitude", "gte", json!(-90)),
        cmp("telemetry_latitude", "lte", json!(90)),
        cmp("telemetry_longitude", "gte", json!(-180)),
        cmp("telemetry_longitude", "lte", json!(180)),
        json!({"kind":"not","filter":all(vec![cmp("telemetry_latitude","eq",json!(0)),cmp("telemetry_longitude","eq",json!(0))])}),
    ])
}
const NUMERIC_TELEMETRY: &[&str] = &[
    "telemetry_altitude",
    "telemetry_height",
    "telemetry_speed",
    "telemetry_battery_percent",
    "telemetry_battery_voltage",
    "telemetry_battery_current",
    "telemetry_battery_temp",
    "telemetry_satellites",
    "telemetry_gps_signal",
    "telemetry_rc_signal",
    "telemetry_velocity_x",
    "telemetry_velocity_y",
    "telemetry_velocity_z",
    "telemetry_pitch",
    "telemetry_roll",
    "telemetry_yaw",
];
fn numeric_telemetry(m: &str) -> Result<(), String> {
    if NUMERIC_TELEMETRY.contains(&m) {
        Ok(())
    } else {
        Err(format!("Unsupported telemetry metric {m:?}. Use an exact supported raw telemetry field: {}. For altitude use telemetry_altitude, not max_altitude or altitude; max_altitude is a flight summary field.", NUMERIC_TELEMETRY.join(", ")))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Anomalies {
    #[serde(default)]
    flight_id: Option<i64>,
    #[serde(default)]
    filter: Value,
    #[serde(default)]
    baseline_filter: Value,
    #[serde(default)]
    metrics: Vec<String>,
    #[serde(default)]
    telemetry_metric: Option<String>,
    #[serde(default = "default_threshold")]
    threshold: f64,
    #[serde(default = "default_limit")]
    limit: usize,
}
async fn anomalies(
    db: Arc<Database>,
    mut a: Anomalies,
    request: Value,
    zone: &str,
) -> Result<QueryResult, String> {
    limit(a.limit, 100)?;
    if a.flight_id.is_some() {
        numeric_telemetry(
            a.telemetry_metric
                .as_deref()
                .unwrap_or("telemetry_battery_percent"),
        )?;
    }
    if !a.threshold.is_finite() || !(1.0..=10.0).contains(&a.threshold) {
        return Err("threshold must be 1–10 standard deviations".into());
    }
    if a.metrics.is_empty() {
        a.metrics = vec![
            "duration_minutes".into(),
            "max_altitude".into(),
            "max_speed".into(),
            "battery_drain_per_minute".into(),
        ]
    };
    if a.metrics
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        != a.metrics.len()
    {
        return Err("Metrics must be unique".into());
    }
    if a.metrics.len() > 4 {
        return Err("Select at most four flight metrics".into());
    }
    let mut baseline = a.baseline_filter.clone();
    let target_filter;
    let mut baseline_description="Explicit baseline filter, or all profile flights. Candidate flights can overlap this baseline.".to_string();
    if let Some(id) = a.flight_id {
        positive_id(id)?;
        let target=run(db.clone(),json!({"select":[selection("drone_serial","value","serial"),selection("drone_model","value","model"),selection("start_time_epoch_ms","value","date")],"filter":cmp("id","eq",json!(id)),"limit":1}),zone).await?;
        let t = target
            .rows
            .first()
            .ok_or("Flight not found in this profile")?;
        let (field, value) = if t["serial"].as_str().is_some_and(|v| !v.is_empty()) {
            ("drone_serial", t["serial"].clone())
        } else if !t["model"].is_null() {
            ("drone_model", t["model"].clone())
        } else {
            return Err("Flight has no aircraft serial or model for a comparable baseline".into());
        };
        if t["date"].is_null() {
            return Err("A dated flight is required for a historical baseline".into());
        }
        baseline = all(vec![
            baseline,
            cmp(field, "eq", value),
            cmp("id", "ne", json!(id)),
            cmp("start_time_epoch_ms", "lte", t["date"].clone()),
        ]);
        target_filter = cmp("id", "eq", json!(id));
        baseline_description=format!("Historical same-{field} flights; target excluded; flights after target excluded. User baseline filter further restricts this cohort.");
    } else {
        target_filter = a.filter.clone()
    }
    let mut selects = vec![
        selection("id", "value", "flight_id"),
        selection("display_name", "value", "flight"),
        selection("drone_name", "value", "drone"),
    ];
    for (i, m) in a.metrics.iter().enumerate() {
        selects.push(selection(m, "value", &format!("metric_{i}")))
    }
    let candidates=run(db.clone(),json!({"select":selects,"filter":target_filter,"order_by":[{"field":"flight_id","descending":true}],"limit":a.limit}),zone).await?;
    let mut rows = vec![];
    let mut links = vec![];
    let mut baseline_rows = vec![];
    for (i, m) in a.metrics.iter().enumerate() {
        let stats=run(db.clone(),json!({"select":[selection(m,"count","count"),selection(m,"avg","mean"),selection(m,"stddev_pop","stddev"),selection(m,"min","minimum"),selection(m,"max","maximum")],"filter":baseline}),zone).await?;
        let s = &stats.rows[0];
        let n = s["count"].as_u64().unwrap_or(0);
        baseline_rows.push(json!({"metric":m,"baseline_count":n,"baseline_mean":s["mean"],"baseline_stddev":s["stddev"],"baseline_min":s["minimum"],"baseline_max":s["maximum"],"status":if n<3 {"insufficient_baseline"} else {"available"}}));
        for (index, c) in candidates.rows.iter().enumerate() {
            let observed = num(c, &format!("metric_{i}"));
            let mean = num(s, "mean");
            let std = num(s, "stddev");
            let z = if n < 3 {
                None
            } else {
                observed.zip(mean).zip(std).and_then(|((v, b), sd)| {
                    if sd > 0.0 {
                        Some((v - b) / sd)
                    } else {
                        None
                    }
                })
            };
            let outside = if n < 3 {
                None
            } else {
                observed.zip(mean).map(|(v, b)| {
                    if std == Some(0.0) {
                        v != b
                    } else {
                        z.is_some_and(|z| z.abs() >= a.threshold)
                    }
                })
            };
            rows.push(json!({"flight":c["flight"],"drone":c["drone"],"metric":m,"observed":finite(observed),"baseline_mean":s["mean"],"baseline_stddev":s["stddev"],"baseline_count":n,"baseline_min":s["minimum"],"baseline_max":s["maximum"],"z_score":finite(z),"flagged":outside,"status":if n<3{"insufficient_baseline"}else if observed.is_none(){"missing_observation"}else if std==Some(0.0){"constant_baseline"}else{"assessed"}}));
            links.push(candidates.row_flight_ids[index]);
        }
    }
    if a.flight_id.is_none() {
        let mut paired: Vec<_> = rows
            .into_iter()
            .zip(links)
            .filter(|(r, _)| r["flagged"] == true)
            .collect();
        paired.sort_by(|(a, _), (b, _)| {
            num(b, "z_score")
                .unwrap_or(0.0)
                .abs()
                .total_cmp(&num(a, "z_score").unwrap_or(0.0).abs())
        });
        (rows, links) = paired.into_iter().unzip();
    }
    let note=format!("{baseline_description} Population mean/stddev of flight-level metrics; threshold {} standard deviations. Minimum 3 non-null baseline flights. Constant baselines have no finite z-score; differing observations are flagged explicitly. Baseline aggregates cover all matching records; candidates are the latest {} matching flight IDs before ranking. Outliers are investigation leads, not a safety/causal diagnosis.",a.threshold,a.limit);
    let mut r = result(
        "Baseline deviations",
        &[
            "flight",
            "drone",
            "metric",
            "observed",
            "baseline_mean",
            "baseline_stddev",
            "baseline_count",
            "baseline_min",
            "baseline_max",
            "z_score",
            "flagged",
            "status",
        ],
        rows,
        request,
        zone,
        &note,
    );
    r.column_meta.insert(
        "flight".into(),
        super::analytics::ColumnMeta {
            field: "display_name".into(),
            op: "value".into(),
            bucket: None,
        },
    );
    r.column_meta.insert(
        "drone".into(),
        super::analytics::ColumnMeta {
            field: "drone_name".into(),
            op: "value".into(),
            bucket: None,
        },
    );
    r.row_flight_ids = links;
    r.truncated = candidates.truncated;
    if a.flight_id.is_none() {
        r.sections.push(result(
            "Baseline coverage",
            &[
                "metric",
                "baseline_count",
                "baseline_mean",
                "baseline_stddev",
                "baseline_min",
                "baseline_max",
                "status",
            ],
            baseline_rows,
            r.request.clone(),
            zone,
            &r.note,
        ));
    }
    if a.flight_id.is_some() {
        r.chart = Some(chart("bar", "metric", &["z_score"], None))
    }
    if let Some(id) = a.flight_id {
        let metric = a
            .telemetry_metric
            .as_deref()
            .unwrap_or("telemetry_battery_percent");
        numeric_telemetry(metric)?;
        // At most 51 phase buckets. Bound flights to positive duration so normalization has meaning.
        let phase_filter = all(vec![
            cmp("duration_secs", "gt", json!(0)),
            cmp("telemetry_timestamp_ms", "gte", json!(0)),
            cmp("telemetry_progress_pct", "lte", json!(100)),
        ]);
        let phase = json!({"field":"telemetry_progress_pct","alias":"progress_pct","bucket":"range","width":2});
        let target=run(db.clone(),json!({"source":"telemetry","select":[phase,selection(metric,"avg","observed")],"filter":all(vec![phase_filter.clone(),cmp("id","eq",json!(id))]),"group_by":["progress_pct"],"order_by":[{"field":"progress_pct"}],"limit":100}),zone).await?;
        let mut low = selection(metric, "percentile", "baseline_low");
        low["percentile"] = json!(0.05);
        let mut high = selection(metric, "percentile", "baseline_high");
        high["percentile"] = json!(0.95);
        let base=run(db.clone(),json!({"source":"telemetry","select":[phase,selection(metric,"avg","baseline_mean"),low,high,selection("id","count_distinct","baseline_flights")],"filter":all(vec![phase_filter,baseline,cmp(metric,"not_null",Value::Null)]),"group_by":["progress_pct"],"order_by":[{"field":"progress_pct"}],"limit":100}),zone).await?;
        let mut phases: Vec<f64> = target
            .rows
            .iter()
            .chain(base.rows.iter())
            .filter_map(|v| num(v, "progress_pct"))
            .collect();
        phases.sort_by(f64::total_cmp);
        phases.dedup();
        let rows=phases.into_iter().map(|x|{let observed=target.rows.iter().find(|r|num(r,"progress_pct")==Some(x));let b=base.rows.iter().find(|r|num(r,"progress_pct")==Some(x));let enough=b.is_some_and(|r|r["baseline_flights"].as_u64().unwrap_or(0)>=3);json!({"progress_pct":x,"observed":observed.and_then(|r|num(r,"observed")),"baseline_mean":if enough{b.and_then(|r|num(r,"baseline_mean"))}else{None},"baseline_low":if enough{b.and_then(|r|num(r,"baseline_low"))}else{None},"baseline_high":if enough{b.and_then(|r|num(r,"baseline_high"))}else{None},"baseline_flights":b.map(|r|r["baseline_flights"].clone()).unwrap_or(json!(0))})}).collect();
        let mut plot=result(&format!("{metric}: historical baseline envelope"),&["progress_pct","observed","baseline_mean","baseline_low","baseline_high","baseline_flights"],rows,r.request.clone(),zone,"Flight progress = elapsed ms / recorded flight duration; two-percentage-point bins. Target values are sample means. Historical envelope is sample-weighted 5th–95th percentiles, not a confidence interval; flights with more samples have more influence. Baseline hidden in bins with fewer than 3 distinct flights. Progress aligns duration, not equivalent manoeuvres/conditions. Missing samples stay null.");
        for column in ["observed", "baseline_mean", "baseline_low", "baseline_high"] {
            plot.column_meta.insert(
                column.into(),
                super::analytics::ColumnMeta {
                    field: metric.into(),
                    op: if column.contains("low") || column.contains("high") {
                        "percentile".into()
                    } else {
                        "avg".into()
                    },
                    bucket: None,
                },
            );
        }
        plot.column_meta.insert(
            "progress_pct".into(),
            super::analytics::ColumnMeta {
                field: "telemetry_progress_pct".into(),
                op: "value".into(),
                bucket: None,
            },
        );
        plot.source = "telemetry".into();
        let mut spec = chart(
            "line",
            "progress_pct",
            &["observed", "baseline_mean", "baseline_low", "baseline_high"],
            None,
        );
        spec.band = Some(super::analytics::Band {
            lower: "baseline_low".into(),
            upper: "baseline_high".into(),
        });
        plot.chart = Some(spec);
        plot.row_flight_ids = vec![Some(id); plot.rows.len()];
        r.sections.push(plot);
    }
    Ok(r)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Battery {
    #[serde(default)]
    filter: Value,
    #[serde(default)]
    battery_serial: Option<String>,
    #[serde(default)]
    battery_limit: Option<usize>,
    #[serde(default = "default_limit")]
    limit: usize,
}
async fn battery(
    db: Arc<Database>,
    a: Battery,
    request: Value,
    zone: &str,
) -> Result<QueryResult, String> {
    limit(a.limit, 500)?;
    if a.battery_serial
        .as_ref()
        .is_some_and(|s| s.is_empty() || s.len() > 200)
    {
        return Err("Invalid battery serial".into());
    }
    let mut filter = all(vec![
        a.filter,
        cmp("battery_serial", "not_null", Value::Null),
        cmp("battery_serial", "ne", json!("")),
        a.battery_serial
            .map(|s| cmp("battery_serial", "eq", json!(s)))
            .unwrap_or(Value::Null),
    ]);
    if let Some(count) = a.battery_limit {
        limit(count, 100)?;
        let top=run(db.clone(),json!({"select":[selection("battery_serial","value","serial"),selection("*","count","flights")],"filter":filter,"group_by":["serial"],"order_by":[{"field":"flights","descending":true},{"field":"serial"}],"limit":count}),zone).await?;
        if top.rows.is_empty() {
            filter = all(vec![filter, cmp("id", "lt", json!(0))]);
        } else {
            filter = all(vec![
                filter,
                cmp(
                    "battery_serial",
                    "in",
                    json!(top
                        .rows
                        .iter()
                        .map(|row| row["serial"].clone())
                        .collect::<Vec<_>>()),
                ),
            ]);
        }
    }
    let fields = [
        "display_name",
        "battery_name",
        "battery_serial",
        "start_time",
        "cycle_count",
        "battery_start_percent",
        "battery_end_percent",
        "battery_drain_per_minute",
        "battery_min_voltage",
        "battery_voltage_range",
        "battery_max_temperature",
        "battery_max_cell_imbalance",
        "telemetry_battery_count",
    ];
    let mut r=run(db.clone(),json!({"select":fields.iter().map(|f|selection(f,"value",f)).collect::<Vec<_>>(),"filter":filter,"order_by":[{"field":"start_time","descending":true}],"limit":a.limit,"title":"Battery operating indicators"}),zone).await?;
    r.request = request;
    r.note.push_str(" Discharge is first-minus-last non-null battery percentage divided by elapsed battery-sample minutes. Negative values can indicate charging/swaps/inconsistent data. Voltage range is max-minus-min voltage, NOT load-corrected sag. Cell imbalance is maximum difference between recorded cell voltages; malformed/missing cell arrays stay null. Temperature is Celsius. Operating conditions confound comparisons: these indicators cannot predict remaining life. No serial means no reliable battery grouping. Scatter omits missing cycle counts/discharge.");
    let mut sel = vec![
        selection("battery_serial", "value", "battery_serial"),
        selection("battery_name", "value", "battery_name"),
        selection("battery_drain_per_minute", "min", "minimum"),
    ];
    for (alias, p) in [("q1", 0.25), ("median", 0.5), ("q3", 0.75)] {
        let mut s = selection("battery_drain_per_minute", "percentile", alias);
        s["percentile"] = json!(p);
        sel.push(s)
    }
    sel.push(selection("battery_drain_per_minute", "max", "maximum"));
    sel.push(selection("*", "count", "flights"));
    sel.push(selection(
        "battery_drain_per_minute",
        "count",
        "discharge_available_flights",
    ));
    sel.push(selection("cycle_count", "count", "known_cycle_flights"));
    let mut distribution=run(db.clone(),json!({"select":sel,"filter":filter,"group_by":["battery_serial","battery_name"],"order_by":[{"field":"flights","descending":true},{"field":"battery_serial"}],"limit":100,"title":"Discharge distributions by battery"}),zone).await?;
    distribution.chart = Some(chart(
        "boxplot",
        "battery_serial",
        &["minimum", "q1", "median", "q3", "maximum"],
        None,
    ));
    distribution.note.push_str(" flights counts all matching flights; discharge_available_flights and known_cycle_flights are exact non-null coverage counts, not inferred from the bounded scatter table. Negative start-minus-end percentage or rate means recorded charge increased; it is not ordinary discharge. Each non-null flight contributes one discharge rate. Whiskers show actual minimum/maximum, not Tukey fences. All matched flights contribute to each battery's statistics, independently of the bounded flight table. Missing discharge values excluded.");
    r.sections.push(distribution);
    let mut scatter=run(db,json!({"select":[selection("display_name","value","flight"),selection("battery_serial","value","battery_serial"),selection("battery_name","value","battery_name"),selection("cycle_count","value","cycle_count"),selection("battery_drain_per_minute","value","drain_per_minute"),selection("start_time","value","date")],"filter":all(vec![filter,cmp("cycle_count","not_null",Value::Null),cmp("battery_drain_per_minute","not_null",Value::Null)]),"order_by":[{"field":"date","descending":true}],"limit":500,"title":"Recorded cycle count versus discharge rate"}),zone).await?;
    scatter.chart = Some(chart(
        "scatter",
        "cycle_count",
        &["drain_per_minute"],
        Some("battery_serial"),
    ));
    scatter.note.push_str(" Cycle/discharge availability is filtered before the 500-point limit, independently of the recent-flight table. Missing cycles are unknown, not zero. Truncation applies only to this scatter's point limit; exact per-battery coverage counts are in the distribution section. These indicators do not establish battery life or safety.");
    r.sections.push(scatter);
    r.note.push_str(" The recent-flight table is independently bounded; exact coverage counts and the separate non-null cycle scatter must not be inferred from its limited rows.");
    Ok(r)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Quality {
    #[serde(default)]
    filter: Value,
    #[serde(default = "default_gap")]
    gap_ms: f64,
    #[serde(default = "default_limit")]
    limit: usize,
}
async fn quality(
    db: Arc<Database>,
    a: Quality,
    request: Value,
    zone: &str,
) -> Result<QueryResult, String> {
    limit(a.limit, 500)?;
    if !a.gap_ms.is_finite() || a.gap_ms < 1.0 {
        return Err("gap_ms must be positive".into());
    }
    let fields = [
        "display_name",
        "duration_secs",
        "point_count",
        "telemetry_sample_count",
        "telemetry_span_ms",
        "telemetry_max_gap_ms",
        "telemetry_duplicate_count",
        "telemetry_position_count",
        "telemetry_battery_count",
        "battery_temperature_outlier_count",
        "battery_percent_out_of_range_count",
        "battery_nonpositive_voltage_count",
    ];
    let mut r=run(db.clone(),json!({"select":fields.iter().map(|f|selection(f,"value",f)).collect::<Vec<_>>(),"filter":a.filter,"order_by":[{"field":"telemetry_max_gap_ms","descending":true}],"limit":a.limit,"title":"Telemetry data quality"}),zone).await?;
    r.request = request;
    r.columns.extend(
        [
            "position_coverage_percent",
            "battery_coverage_percent",
            "duration_span_difference_ms",
            "gap_flag",
        ]
        .map(String::from),
    );
    for row in &mut r.rows {
        let count = num(row, "telemetry_sample_count").unwrap_or(0.0);
        row["position_coverage_percent"] = finite(
            num(row, "telemetry_position_count")
                .filter(|_| count > 0.0)
                .map(|n| 100.0 * n / count),
        );
        row["battery_coverage_percent"] = finite(
            num(row, "telemetry_battery_count")
                .filter(|_| count > 0.0)
                .map(|n| 100.0 * n / count),
        );
        row["duration_span_difference_ms"] = finite(
            num(row, "duration_secs")
                .zip(num(row, "telemetry_span_ms"))
                .map(|(d, s)| s - d * 1000.0),
        );
        row["gap_flag"] = json!(num(row, "telemetry_max_gap_ms").map(|g| g > a.gap_ms));
    }
    let total=run(db.clone(),json!({"select":[selection("*","count","flights"),selection("telemetry_sample_count","sum","samples"),selection("telemetry_duplicate_count","sum","duplicate_timestamps"),selection("telemetry_position_count","sum","position_samples"),selection("telemetry_battery_count","sum","battery_samples"),selection("battery_temperature_outlier_count","sum","temperature_outlier_samples"),selection("battery_percent_out_of_range_count","sum","percentage_out_of_range_samples"),selection("battery_nonpositive_voltage_count","sum","nonpositive_voltage_samples"),selection("battery_min_temperature","min","minimum_recorded_temperature_c"),selection("battery_max_temperature","max","maximum_recorded_temperature_c")],"filter":a.filter,"title":"Exact coverage totals"}),zone).await?;
    let missing=run(db.clone(),json!({"select":[selection("*","count","flights_without_telemetry")],"filter":all(vec![a.filter.clone(),cmp("telemetry_sample_count","eq",json!(0))]),"title":"Flights without telemetry"}),zone).await?;
    let gaps=run(db,json!({"select":[selection("*","count","flights_with_large_gaps")],"filter":all(vec![a.filter,cmp("telemetry_max_gap_ms","gt",json!(a.gap_ms))]),"title":"Flights with timestamp gaps"}),zone).await?;
    r.note.push_str(&format!(" Exact summary sections cover all matching flights. Detail rows prioritize largest recorded gaps, bounded by limit. Gap flag > {} ms. Coverage uses actual stored sample count, not metadata point_count; positions exclude invalid coordinates and (0,0). Duration/span differences can reflect logging boundaries. Manual flights can legitimately lack telemetry. Null is missing, never zero coverage when there are no samples. Exact sanity checks count battery percentage outside 0–100, nonpositive pack voltage, and temperature outside -40 to 100 Celsius; these are broad stored-value flags, not device operating limits. Suspect values remain included in recorded-value rankings: inspect parser units/decoding before interpreting them physically. This tool does not establish physical battery health, validate cell balance, calibrate sensors or clear a battery for service. Do not claim unassessed quantities are plausible or recommend replacement/no replacement from completeness alone.",a.gap_ms));
    r.sections = vec![total, missing, gaps];
    Ok(r)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportSection {
    query: analytics::Query,
    #[serde(default)]
    interpretation: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Report {
    title: String,
    sections: Vec<ReportSection>,
}
async fn report(
    db: Arc<Database>,
    a: Report,
    request: Value,
    zone: &str,
) -> Result<QueryResult, String> {
    if a.title.trim().is_empty()
        || a.title.len() > 160
        || a.sections.is_empty()
        || a.sections.len() > 6
    {
        return Err("Report requires title (1–160 characters) and 1–6 evidence sections".into());
    }
    let mut root=result(&a.title,&["section","rows","limited"],vec![],request,zone,&format!("Generated {}. Each section was re-queried from the authorized profile. Query details preserve filters, calculation operations, units, timezone and result limits. Section commentary is model interpretation, not an independently verified conclusion. Correlation does not establish cause. CSV exports only this table; export the report to include all evidence sections.",chrono::Utc::now().to_rfc3339()));
    for section in a.sections {
        if section.interpretation.len() > 2000 {
            return Err("Report commentary exceeds 2000 characters".into());
        }
        let mut r = analytics::query(db.clone(), section.query, zone.into()).await?;
        if !section.interpretation.is_empty() {
            r.note.push_str(&format!(
                "\nModel interpretation: {}",
                section.interpretation
            ))
        };
        root.rows
            .push(json!({"section":r.title,"rows":r.rows.len(),"limited":r.truncated}));
        root.truncated |= r.truncated;
        root.sections.push(r)
    }
    root.row_flight_ids = vec![None; root.rows.len()];
    Ok(root)
}
pub(super) fn metric_definition(name: &str) -> &'static str {
    match name {
        "duration_secs" => "Stored flight duration in seconds. Not the telemetry sample count or elapsed telemetry span.",
        "duration_minutes" => "Stored duration_secs divided by 60.",
        "duration_hours" => "Stored duration_secs divided by 3600; use sum(duration_hours) as the denominator for per-flight-hour cohort rates.",
        "total_distance" => "Stored total flown distance in metres, not straight-line displacement from takeoff.",
        "distance_km" => "Stored total_distance divided by 1000.",
        "max_altitude" => "Flight summary maximum relative altitude, not mean sea level (MSL).",
        "max_speed" => "Stored flight summary maximum speed in metres/second.",
        "home_lat" | "home_lon" => "Stored home/takeoff coordinate in decimal degrees. Missing or invalid coordinates must not be interpreted as (0,0).",
        "start_time" => "Flight start as local wall time in the conversation's IANA timezone. Date buckets and filters use this local time, with DST rules applied per flight.",
        "start_time_epoch_ms" => "Stored flight start as epoch milliseconds; useful for chronologically comparing historical baselines independently of wall-clock timezone changes.",
        "telemetry_sample_count" => "Actual number of telemetry rows stored for this flight, including duplicate timestamps. May differ from metadata point_count.",
        "telemetry_span_ms" => "Maximum minus minimum recorded telemetry timestamp, in milliseconds. A single sample has zero span; no samples gives null.",
        "telemetry_max_gap_ms" => "Largest adjacent timestamp difference within each flight after sorting timestamps. Fewer than two samples gives null.",
        "telemetry_duplicate_count" => "Stored telemetry row count minus distinct timestamp count within each flight.",
        "telemetry_position_count" => "Count of samples with latitude in [-90,90], longitude in [-180,180], excluding the (0,0) sentinel.",
        "telemetry_battery_count" => "Count of non-null battery-percentage samples; this is field availability, not validation of physical accuracy.",
        "battery_start_percent" => "First non-null battery percentage ordered by recorded elapsed timestamp. Duplicate timestamps can make the selected tied value ambiguous.",
        "battery_end_percent" => "Last non-null battery percentage ordered by recorded elapsed timestamp. Duplicate timestamps can make the selected tied value ambiguous.",
        "battery_drop_percent" => "First minus last non-null battery percentage, in percentage points. Negative values may indicate charging, swaps or inconsistent recordings.",
        "battery_drain_per_minute" => "First minus last non-null recorded battery percentage divided by elapsed minutes between those battery samples. Zero or missing span gives null.",
        "battery_voltage_range" => "Maximum minus minimum recorded pack voltage; not load-corrected voltage sag.",
        "battery_min_voltage" => "Minimum non-null recorded pack voltage across this flight.",
        "battery_max_temperature" => "Maximum non-null recorded battery temperature, Celsius. Implausible stored values may reflect unit/decoding issues, not a true physical temperature.",
        "battery_min_temperature" => "Minimum non-null recorded battery temperature, Celsius.",
        "battery_temperature_outlier_count" => "Count of raw samples with temperature below -40 or above 100 Celsius. Broad stored-value sanity flag, not device operating limits.",
        "battery_percent_out_of_range_count" => "Count of raw samples with stored battery percentage below 0 or above 100. Missing values do not count as out-of-range.",
        "battery_nonpositive_voltage_count" => "Count of raw samples with stored pack voltage at or below zero. Does not assess voltage sag or battery health.",
        "battery_max_cell_imbalance" => "Maximum difference between highest and lowest recorded cell voltage at a sample. Invalid/missing arrays are null. This is not an estimate of remaining battery life.",
        "telemetry_timestamp_ms" | "message_timestamp_ms" => "Elapsed milliseconds from the start of this flight, not a Unix timestamp.",
        "telemetry_progress_pct" => "Elapsed telemetry timestamp divided by recorded flight duration, multiplied by 100. Aligns duration, not equivalent manoeuvres or environmental conditions.",
        "telemetry_latitude" | "telemetry_longitude" => "Recorded sample coordinate in decimal degrees; inspect GPS availability and reject invalid/sentinel positions before mapping.",
        "telemetry_altitude" | "telemetry_height" => "Recorded relative altitude/height in metres. Do not treat as MSL.",
        "telemetry_altitude_abs" => "Recorded absolute altitude in metres, where the parser supplies it. Vertical datum and availability depend on the log source.",
        "telemetry_vps_height" => "Recorded downward visual-positioning height in metres, where available; surface/sensor conditions affect interpretation.",
        "telemetry_speed" => "Recorded ground speed in metres/second. A telemetry mean weights each available sample equally, not each second or flight.",
        "telemetry_battery_percent" => "Recorded state-of-charge percentage, generally 0–100. Differences are percentage points, not relative percentages.",
        "telemetry_battery_voltage" => "Recorded pack voltage in volts. Comparisons depend on cell count, state of charge, temperature and electrical load.",
        "telemetry_battery_temp" => "Recorded battery temperature in Celsius.",
        "telemetry_satellites" => "Recorded satellite count; count alone does not establish GPS position accuracy.",
        "telemetry_rc_signal" | "telemetry_rc_uplink" | "telemetry_rc_downlink" | "telemetry_gps_signal" => "Recorded signal indicator on the parser-native scale. Do not assume different models/log formats use comparable percentages.",
        "point_count" => "Imported flight metadata point count; compare against telemetry_sample_count to assess actual stored coverage.",
        "cycle_count" => "Recorded battery cycle count at this flight, when supplied by the log. Missing is unknown, not zero cycles.",
        "photo_count" | "video_count" => "Stored flight summary media-event count. It does not imply the application has the media files.",
        "drone_name" => "Equipment display name, then aircraft name/model/serial fallback. Names are not unique identities; use serial for equipment cohorts.",
        "battery_name" => "Equipment display name with battery-serial fallback. Names are not unique identities; use serial for battery cohorts.",
        "tags" => "Comma-separated display tags; tag filters match exact case-insensitive stored tags, rather than parsing this display string.",
        "notes" | "message_text" => "Untrusted recorded text; displayed excerpts are at most 2000 characters, but filters search full stored text.",
        "id" => "Internal flight identity used for verified navigation and distinct flight counts. Never expose it as a user-facing table column or prose identifier.",
        _ => "Raw stored field. Inspect query operations, field availability and parser provenance before interpreting it; no implicit unit conversion or missing-value imputation is applied.",
    }
}
pub async fn execute(
    db: Arc<Database>,
    name: &str,
    args: Value,
    zone: &str,
) -> Result<(Value, Option<QueryResult>), String> {
    macro_rules! parse {
        ($t:ty) => {
            serde_json::from_value::<$t>(args.clone())
                .map_err(|e| format!("Invalid {name} arguments: {e}"))?
        };
    }
    let r = match name {
        "compare_cohorts" => compare(db, parse!(Compare), args, zone).await?,
        "analyze_flight_timeline" => {
            if args.get("annotations").is_some() {
                return Err("analyze_flight_timeline reads and annotates actual recorded messages automatically. Omit annotations and repeat this tool with the SAME flight_id, metrics, start_ms and end_ms. Do not replace the bounded window with an unbounded telemetry query.".into());
            }
            timeline(db, parse!(Timeline), args, zone).await?
        }
        "detect_anomalies" => anomalies(db, parse!(Anomalies), args, zone).await?,
        "analyze_battery_health" => battery(db, parse!(Battery), args, zone).await?,
        "assess_data_quality" => quality(db, parse!(Quality), args, zone).await?,
        "build_investigation_report" => report(db, parse!(Report), args, zone).await?,
        "explain_metric" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Explain {
                metric: String,
            }
            let a = parse!(Explain);
            if a.metric.len() > 100 {
                return Err("Metric name too long".into());
            }
            let supported = analytics::describe_data();
            let known = [
                "flight_fields",
                "derived_flight_fields",
                "telemetry_fields",
                "message_fields",
            ]
            .iter()
            .any(|key| {
                supported[key]
                    .as_array()
                    .is_some_and(|v| v.iter().any(|v| v == &a.metric))
            });
            if !known {
                return Err("Unknown metric; use describe_data".into());
            }
            let unit = metric_unit(&a.metric);
            return Ok((
                json!({"metric":a.metric,"unit":unit,"database_expression":derived_field(&a.metric),"definition":metric_definition(&a.metric),"aggregation_rules":supported["rules"],"caveats":"Telemetry mean is sample-weighted, not time-weighted. Flight-source aggregates weight each non-null flight once. Null remains missing. Count(*) counts rows of the selected source; use count_distinct(id) for flight counts on telemetry/messages. Percentiles exclude nulls. No signal scale conversion or causal inference is assumed."}),
                None,
            ));
        }
        _ => return Err("Unknown tool".into()),
    };
    Ok((
        serde_json::to_value(&r).map_err(|e| e.to_string())?,
        Some(r),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn battery_ranking_counts_missing_telemetry_and_exact_cycle_coverage() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
        db.analytics_connection().unwrap().execute_batch("INSERT INTO flights(id,file_name,display_name,battery_serial,cycle_count) VALUES(1,'a','A','MOST',NULL),(2,'b','B','MOST',7),(3,'c','C','MOST',NULL),(4,'d','D','LESS',1),(5,'e','E','LESS',2); INSERT INTO telemetry(flight_id,timestamp_ms,battery_percent) VALUES(4,0,90),(4,60000,70),(5,0,80),(5,60000,50)").unwrap();
        let (data, _) = execute(
            db.clone(),
            "analyze_battery_health",
            json!({"battery_limit":1,"limit":1}),
            "UTC",
        )
        .await
        .unwrap();
        let row = &data["sections"][0]["rows"][0];
        assert_eq!(row["battery_serial"], "MOST");
        assert_eq!(row["flights"], 3);
        assert_eq!(row["discharge_available_flights"], 0);
        assert_eq!(row["known_cycle_flights"], 1);
        assert!(row["median"].is_null());
        assert_eq!(data["rows"].as_array().unwrap().len(), 1);
        assert_eq!(data["truncated"], true);
        let (data, _) = execute(
            db.clone(),
            "analyze_battery_health",
            json!({"battery_limit":2,"limit":1}),
            "UTC",
        )
        .await
        .unwrap();
        assert_eq!(data["rows"].as_array().unwrap().len(), 1);
        let scatter = &data["sections"][1];
        assert_eq!(scatter["chart"]["kind"], "scatter");
        assert_eq!(scatter["rows"].as_array().unwrap().len(), 2);
        assert!(scatter["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["battery_serial"] == "LESS"));
        assert!(execute(
            db,
            "analyze_battery_health",
            json!({"battery_limit":0}),
            "UTC"
        )
        .await
        .is_err());
        assert!(
            analytics::describe_data()["metric_definitions"]["battery_drop_percent"]
                .as_str()
                .unwrap()
                .contains("First minus last")
        );
    }
    fn database() -> (tempfile::TempDir, Arc<Database>) {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
        let c = db.analytics_connection().unwrap();
        for id in 1..=6 {
            c.execute("INSERT INTO flights(id,file_name,display_name,drone_serial,drone_model,battery_serial,start_time,duration_secs,total_distance,max_altitude,max_speed,cycle_count,point_count) VALUES (?,?,?,'DRONE','Mini','BAT',CAST(? AS TIMESTAMP),100,1000,?,?,?,10)",duckdb::params![id,format!("flight{id}"),format!("Flight {id}"),format!("2026-01-0{id} 10:00:00"),if id==6{1000.0}else{50.0},if id==6{50.0}else{10.0},id]).unwrap();
            for point in 0..=10 {
                let battery = if id == 6 {
                    100 - point * 5
                } else {
                    100 - point * 2
                };
                c.execute("INSERT INTO telemetry(flight_id,timestamp_ms,battery_percent,battery_voltage,battery_temp,cell_voltages,speed,latitude,longitude) VALUES (?,?,?,?,?,'[4.1,4.0,4.05]',?,47.5,19.1)",duckdb::params![id,point*10_000,battery,12.6-point as f64*0.1,30.0+point as f64,point as f64]).unwrap();
            }
        }
        c.execute_batch("INSERT INTO flights(id,file_name,display_name) VALUES(7,'manual','Manual'); INSERT INTO flight_messages VALUES(6,50000,'warning','Synthetic low battery'); INSERT INTO telemetry(flight_id,timestamp_ms,cell_voltages) VALUES(6,50000,'malformed')").unwrap();
        (dir, db)
    }
    #[tokio::test]
    async fn quality_reports_exact_suspect_values_without_a_health_diagnosis() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
        db.analytics_connection().unwrap().execute_batch("INSERT INTO flights(id,file_name,display_name) VALUES(1,'a','A'); INSERT INTO telemetry(flight_id,timestamp_ms,battery_percent,battery_voltage,battery_temp) VALUES(1,0,101,0,307.4),(1,1000,-5,-1,-50),(1,2000,80,12,30);").unwrap();
        let (_, quality) = execute(db, "assess_data_quality", json!({}), "UTC")
            .await
            .unwrap();
        let quality = quality.unwrap();
        let summary = &quality.sections[0].rows[0];
        assert_eq!(summary["temperature_outlier_samples"], 2);
        assert_eq!(summary["percentage_out_of_range_samples"], 2);
        assert_eq!(summary["nonpositive_voltage_samples"], 2);
        assert!(
            (summary["maximum_recorded_temperature_c"].as_f64().unwrap() - 307.4).abs() < 0.001
        );
        assert_eq!(summary["minimum_recorded_temperature_c"], -50.0);
        assert!(quality.note.contains("not device operating limits"));
        assert!(quality
            .note
            .contains("does not establish physical battery health"));
    }
    #[tokio::test]
    async fn rich_chart_queries_validate_shapes_and_preserve_scatter_duplicates() {
        let (_dir, db) = database();
        let scatter = json!({"select":[selection("max_altitude","value","altitude"),selection("max_speed","value","speed")],"filter":cmp("id","lte",json!(6)),"chart":{"kind":"scatter","x":"altitude","y":["speed"]}});
        assert_eq!(run(db.clone(), scatter, "UTC").await.unwrap().rows.len(), 6);
        let mut grouped = json!({"select":[selection("drone_model","value","model"),selection("max_speed","avg","speed"),selection("max_altitude","avg","altitude")],"group_by":["model"],"chart":{"kind":"bar","x":"model","y":["speed","altitude"],"series":"invented_legend"}});
        let error = run(db.clone(), grouped.clone(), "UTC").await.err().unwrap();
        assert!(error.contains("omit series"), "{error}");
        grouped["chart"].as_object_mut().unwrap().remove("series");
        assert!(run(db.clone(), grouped, "UTC").await.is_ok());
        let mut selections = vec![selection("drone_model", "value", "model")];
        for (alias, p) in [
            ("lo", 0.0),
            ("q1", 0.25),
            ("median", 0.5),
            ("q3", 0.75),
            ("hi", 1.0),
        ] {
            let mut s = selection("max_speed", "percentile", alias);
            s["percentile"] = json!(p);
            selections.push(s);
        }
        let boxplot = json!({"select":selections,"group_by":["model"],"filter":cmp("id","lte",json!(6)),"chart":{"kind":"boxplot","x":"model","y":["lo","q1","median","q3","hi"]}});
        assert!(run(db.clone(), boxplot.clone(), "UTC").await.is_ok());
        let mut reversed = boxplot;
        reversed["chart"]["y"] = json!(["hi", "q3", "median", "q1", "lo"]);
        assert!(run(db.clone(), reversed, "UTC").await.is_err());
        let heat = json!({"select":[selection("drone_model","value","model"),selection("battery_serial","value","battery"),selection("*","count","flights")],"group_by":["model","battery"],"chart":{"kind":"heatmap","x":"model","y":["flights"],"series":"battery"}});
        assert!(run(db.clone(), heat.clone(), "UTC").await.is_ok());
        let mut bad = heat;
        bad["chart"].as_object_mut().unwrap().remove("series");
        assert!(run(db.clone(), bad, "UTC").await.is_err());
        let map = json!({"source":"telemetry","select":[selection("telemetry_longitude","value","longitude"),selection("telemetry_latitude","value","latitude")],"filter":cmp("id","eq",json!(6)),"chart":{"kind":"map","x":"longitude","y":["latitude"]}});
        assert_eq!(run(db.clone(), map, "UTC").await.unwrap().rows.len(), 12);
        let fake_map = json!({"select":[selection("max_speed","value","longitude"),selection("max_altitude","value","latitude")],"chart":{"kind":"map","x":"longitude","y":["latitude"]}});
        assert!(run(db, fake_map, "UTC").await.is_err());
    }
    #[tokio::test]
    async fn investigation_math_baselines_quality_timeline_and_reports() {
        let (_dir, db) = database();
        let (v,_) = execute(db.clone(),"compare_cohorts",json!({"cohorts":[{"name":"Earlier","filter":cmp("id","lt",json!(6))},{"name":"Target","filter":cmp("id","eq",json!(6))}],"metrics":[{"field":"total_distance","op":"sum","normalize":"flight_hour"}]}),"UTC").await.unwrap();
        assert!((v["rows"][0]["value"].as_f64().unwrap() - 36000.0).abs() < 0.001);
        assert_eq!(v["rows"][0]["unit"], "metres/flight hour");
        assert_eq!(v["rows"][1]["change_percent"], 0.0);
        let (v, _) = execute(
            db.clone(),
            "detect_anomalies",
            json!({"flight_id":6,"metrics":["max_altitude"]}),
            "UTC",
        )
        .await
        .unwrap();
        assert_eq!(v["rows"][0]["baseline_count"], 5);
        assert_eq!(v["rows"][0]["flagged"], true);
        assert_eq!(v["rows"][0]["status"], "constant_baseline");
        assert!(v["rows"][0]["z_score"].is_null());
        let phases = v["sections"][0]["rows"].as_array().unwrap();
        let last = phases.last().unwrap();
        assert_eq!(last["observed"], 50.0);
        assert_eq!(last["baseline_mean"], 80.0);
        assert_eq!(last["baseline_flights"], 5);
        let (small, _) = execute(
            db.clone(),
            "detect_anomalies",
            json!({"flight_id":2,"metrics":["max_altitude"]}),
            "UTC",
        )
        .await
        .unwrap();
        assert_eq!(small["rows"][0]["status"], "insufficient_baseline");
        assert!(small["sections"][0]["rows"][0]["baseline_mean"].is_null());
        let (v, _) = execute(
            db.clone(),
            "assess_data_quality",
            json!({"gap_ms":5000,"limit":2}),
            "UTC",
        )
        .await
        .unwrap();
        assert_eq!(v["sections"][0]["rows"][0]["flights"], 7);
        assert_eq!(v["sections"][0]["rows"][0]["duplicate_timestamps"], 1);
        assert_eq!(v["sections"][1]["rows"][0]["flights_without_telemetry"], 1);
        assert_eq!(v["truncated"], true);
        let (v,_) = execute(db.clone(),"analyze_flight_timeline",json!({"flight_id":6,"metrics":["telemetry_speed"],"include_map":true,"bucket_ms":10000}),"UTC").await.unwrap();
        assert_eq!(v["sections"][0]["chart"]["annotations"][0]["x"], 50000.0);
        assert_eq!(v["sections"][1]["chart"]["kind"], "map");
        assert_eq!(v["sections"][0]["row_flight_ids"][0], 6);
        let (v, _) = execute(
            db.clone(),
            "analyze_battery_health",
            json!({"battery_serial":"BAT"}),
            "UTC",
        )
        .await
        .unwrap();
        let row = &v["rows"][0];
        assert!((row["battery_drain_per_minute"].as_f64().unwrap() - 30.0).abs() < 0.001);
        assert!((row["battery_max_cell_imbalance"].as_f64().unwrap() - 0.1).abs() < 0.001);
        assert_eq!(v["sections"][0]["chart"]["kind"], "boxplot");
        let (v,_) = execute(db.clone(),"build_investigation_report",json!({"title":"Evidence","sections":[{"query":{"select":[selection("display_name","value","flight"),selection("max_speed","value","speed")],"filter":cmp("id","eq",json!(6)),"chart":{"kind":"scatter","x":"speed","y":["speed"]}},"interpretation":"An investigation lead."}]}),"UTC").await.unwrap();
        assert_eq!(v["sections"][0]["row_flight_ids"][0], 6);
        assert!(v["sections"][0]["note"]
            .as_str()
            .unwrap()
            .contains("Model interpretation"));
        assert!(execute(
            db.clone(),
            "analyze_flight_timeline",
            json!({"flight_id":6,"metrics":["telemetry_speed"],"bucket_ms":0.1}),
            "UTC"
        )
        .await
        .is_err());
        assert!(execute(
            db.clone(),
            "detect_anomalies",
            json!({"metrics":["api_key"]}),
            "UTC"
        )
        .await
        .is_err());
        assert!(execute(db.clone(),"build_investigation_report",json!({"title":"Bad","sections":[{"query":{"select":[selection("secrets","value","value")]}}]}),"UTC").await.is_err());
        assert!(execute(
            db.clone(),
            "explain_metric",
            json!({"metric":"telemetry_speed","sql":"DROP TABLE flights"}),
            "UTC"
        )
        .await
        .is_err());
        let defs = analytics::definitions();
        assert_eq!(defs.len(), 11);
        assert!(
            !defs
                .iter()
                .any(|d| ["analyze_locations", "save_analysis"]
                    .contains(&d["name"].as_str().unwrap()))
        );
    }
}
