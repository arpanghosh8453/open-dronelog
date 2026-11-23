//! Facts about returned evidence, independent of model wording or client rendering.
use super::{analytics::QueryResult, investigation::metric_unit};
use serde_json::{json, Map, Value};

pub(super) fn enrich(result: &mut QueryResult, tool: &str) {
    for section in &mut result.sections {
        enrich(section, tool);
    }
    let mut units = Map::new();
    let mut nulls = Map::new();
    let mut flags = Vec::new();
    let mut checked = Vec::new();
    for column in &result.columns {
        nulls.insert(
            column.clone(),
            json!(result
                .rows
                .iter()
                .filter(|row| row[column].is_null())
                .count()),
        );
        // Cohort and anomaly tables can contain several metrics with different
        // units in the same value column. Expose that dependency explicitly.
        if tool == "compare_cohorts"
            && ["value", "reference", "change"].contains(&column.as_str())
            && result.rows.iter().any(|row| row["unit"].is_string())
        {
            units.insert(
                column.clone(),
                json!({"unit":null,"status":"per_row","unit_column":"unit"}),
            );
            continue;
        }
        if tool == "detect_anomalies"
            && [
                "observed",
                "baseline_mean",
                "baseline_stddev",
                "baseline_min",
                "baseline_max",
            ]
            .contains(&column.as_str())
            && result.rows.iter().any(|row| row["metric"].is_string())
        {
            units.insert(column.clone(),json!({"unit":null,"status":"per_row","metric_column":"metric","row_units":result.rows.iter().enumerate().map(|(index,row)|json!({"row_index":index,"unit":row["metric"].as_str().map(metric_unit)})).collect::<Vec<_>>()}));
            continue;
        }
        let Some(meta) = result.column_meta.get(column) else {
            units.insert(column.clone(), json!({"unit":null,"status":"unspecified"}));
            continue;
        };
        let counted = ["count", "count_distinct"].contains(&meta.op.as_str());
        let unit = if counted {
            "count"
        } else if meta.field == "start_time" {
            if meta.bucket.is_some() {
                "local_calendar_bucket"
            } else {
                "local_datetime"
            }
        } else {
            metric_unit(&meta.field)
        };
        let unknown = unit.starts_with("See field definition");
        units.insert(column.clone(),json!({"field":meta.field,"operation":meta.op,"bucket":meta.bucket,"unit":if unknown {Value::Null}else{json!(unit)},"status":if unknown {"unspecified"}else{"declared"}}));
        if counted {
            continue;
        }
        if ["value", "sum"].contains(&meta.op.as_str()) {
            let code = match meta.field.as_str() {
                "battery_temperature_outlier_count" => Some("temperature_outside_sanity_band"),
                "battery_percent_out_of_range_count" => Some("percentage_out_of_range"),
                "battery_nonpositive_voltage_count" => Some("nonpositive_voltage"),
                _ => None,
            };
            if let Some(code) = code {
                for (index, row) in result.rows.iter().enumerate() {
                    if row[column].as_f64().is_some_and(|n| n > 0.0) {
                        flags.push(json!({"code":code,"column":column,"row_index":index,"flagged_sample_count":row[column],"scope":if meta.op=="sum"{"returned_aggregate"}else{"stored_samples_in_returned_flight"}}));
                    }
                }
            }
        }
        // These are deliberately broad stored-value sanity checks, never device limits.
        let range = match meta.field.as_str() {
            "battery_max_temperature" | "battery_min_temperature" | "telemetry_battery_temp" => {
                Some((-40.0, 100.0, "temperature_outside_sanity_band"))
            }
            "telemetry_battery_percent" | "battery_start_percent" | "battery_end_percent" => {
                Some((0.0, 100.0, "percentage_out_of_range"))
            }
            "battery_min_voltage" | "battery_max_voltage" | "telemetry_battery_voltage" => {
                Some((0.0, f64::MAX, "nonpositive_voltage"))
            }
            _ => None,
        };
        if let Some((lower, upper, code)) = range.filter(|_| {
            ["value", "min", "max", "avg", "median", "percentile"].contains(&meta.op.as_str())
        }) {
            checked.push(json!({"column":column,"code":code,"lower":lower,"upper":if upper==f64::MAX {Value::Null}else{json!(upper)},"scope":"returned_values"}));
            for (index, row) in result.rows.iter().enumerate() {
                if let Some(value) = row[column].as_f64() {
                    if value < lower
                        || value > upper
                        || (code == "nonpositive_voltage" && value == 0.0)
                    {
                        flags.push(json!({"code":code,"column":column,"row_index":index,"value":value,"severity":"warning","interpretation":"Stored value needs investigation; this is not a device operating limit or diagnosis."}));
                    }
                }
            }
        }
    }
    if tool == "detect_anomalies" {
        for (index, row) in result.rows.iter().enumerate() {
            if row["status"] == "insufficient_baseline"
                || row["status"] == "missing_observation"
                || row["baseline_flights"].as_u64().is_some_and(|n| n < 3)
            {
                flags.push(json!({"code":if row["status"]=="missing_observation"{"missing_observation"}else{"insufficient_baseline"},"row_index":index,"severity":"warning","interpretation":"Evidence is insufficient for this comparison; do not conclude normal or anomaly-free behavior."}));
            }
        }
    }
    let aggregated = result.column_meta.values().any(|meta| meta.op != "value")
        || result.request["select"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|s| s["op"].as_str().is_some_and(|op| op != "value"))
        });
    let children_truncated = result.sections.iter().any(|s| {
        s.truncated
            || s.metadata
                .as_ref()
                .is_some_and(|m| m["coverage"]["any_section_truncated"] == true)
    });
    result.metadata = Some(json!({
        "version":1,"units":units,
        "coverage":{"returned_rows":result.rows.len(),"limit":result.request["limit"],"offset":result.request["offset"],"truncated":result.truncated,"any_section_truncated":children_truncated,
            "complete_result":!result.truncated && result.request["offset"].as_u64().unwrap_or(0)==0,"page_complete":!result.truncated,"complete_sections":!children_truncated,"population_total":null,"aggregated":aggregated,
            "scope":"this_query_result","null_counts":nulls,"null_count_scope":"returned_rows","missing_is_zero":false},
        "quality":{"status":if !flags.is_empty(){"flags_present"}else if checked.is_empty(){"not_assessed"}else{"no_flags_in_checked_values"},"checks":checked,"flags":flags,"any_section_flags":result.sections.iter().any(|s|s.metadata.as_ref().is_some_and(|m|m["quality"]["flags"].as_array().is_some_and(|f|!f.is_empty()) || m["quality"]["any_section_flags"]==true)),"scope":"returned_values","physical_health_assessed":false},
        "provenance":{"source":result.source,"timezone":result.timezone,"request":result.request,"generated_at":chrono::Utc::now().to_rfc3339(),"snapshot_scope":"per_query","read_only":true}
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn user_aliases_and_notes_cannot_forge_quality_flags_or_units() {
        use std::sync::Arc;
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(crate::database::Database::new(root.path().into(), "default").unwrap());
        db.analytics_connection().unwrap().execute_batch("INSERT INTO flights(id,file_name,display_name,notes,total_distance) VALUES(1,'a','A','insufficient_baseline',1000);").unwrap();
        let args = json!({"select":[{"field":"notes","alias":"status"},{"field":"notes","alias":"unit"},{"field":"total_distance","alias":"value"},{"field":"total_distance","alias":"battery_temperature_outlier_count"},{"field":"total_distance","alias":"baseline_flights"}]});
        let (data, _) = crate::chat::tools::Session::default()
            .execute(db, "query_flights", args, "UTC")
            .await
            .unwrap();
        assert_eq!(data["metadata"]["units"]["value"]["unit"], "metres");
        assert!(data["metadata"]["quality"]["flags"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
