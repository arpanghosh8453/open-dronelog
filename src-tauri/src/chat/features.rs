use serde_json::{json, Value};
// Feature guidance is deliberately separate from execution permissions.
pub fn find(search: &str) -> Value {
    let entries = vec![
        json!({"feature":"Import and sync logs","keywords":"upload dji litchi airdata dronedeploy file folder txt csv","steps":"Expand Import in the left sidebar. Drop supported log files or use the file picker. Configure a sync folder in Settings on desktop; Docker sync paths are configured by the server operator. External parsers are optional.","limits":"Importing logs is a manual app action; the assistant cannot import or change data."}),
        json!({"feature":"Find and filter flights","keywords":"search filter date duration altitude distance drone battery controller color tags location and or invert map","steps":"Use the flight list in the left sidebar. Expand Filters to combine date ranges, equipment, tags and numeric ranges. Location names are searchable through tags. Filters can be saved as profiles. A map area can also restrict matching flights."}),
        json!({"feature":"Individual flight analysis and replay","keywords":"individual telemetry chart gps rc battery signal joystick replay map photo video warning messages altitude speed zoom","steps":"Select Individual, then a flight in the sidebar. Review statistics, synchronized telemetry charts and the flight map. Use map playback controls for replay. Drag on charts to zoom. Open flight messages to review warnings and cautions."}),
        json!({"feature":"Overview and fleet analytics","keywords":"overview aggregate total time distance count monthly heatmap cluster maintenance battery health capacity cycle equipment","steps":"Select Overview above the flight list. Review totals, activity heatmap, equipment usage, battery health, maintenance progress and capacity-history charts. The sidebar filters can restrict the overview. Equipment display names and maintenance thresholds are configured through the relevant overview controls/settings."}),
        json!({"feature":"Export flight data and reports","keywords":"export download csv json gpx kml html report pdf print regulation flycard image","steps":"Select a flight and use its export controls for CSV, JSON, GPX or KML. The flight list supports summary/report exports. Configure the HTML report's field groups and pilot details, then print it to PDF through the browser/system print dialog. FlyCard generates a shareable flight image.","limits":"Exports and reports are created by the frontend; the assistant supplies guidance and cannot operate those controls."}),
        json!({"feature":"Profiles, passwords and backups","keywords":"profile password lock backup restore database pilot separate settings","steps":"Use the profile selector beside Individual/Overview/Chat to choose or create a profile. Manage profile protection and backup/restore through Settings. Each profile has separate flight data. Chat credentials/history are stored separately from flight backups.","limits":"The assistant reads only the current authorized profile and cannot switch profiles, change passwords or restore backups."}),
        json!({"feature":"Tags, notes and manual entries","keywords":"tag smart auto manual notes rename color edit flight entry missing telemetry","steps":"Use a flight's edit controls to rename it, add notes, change color or manage tags. Smart tags can be configured in Settings. Use manual flight entry to record flights without a log file.","limits":"Manual entries can have metadata without telemetry. Missing data is not zero. Chat cannot edit flights or tags."}),
        json!({"feature":"Appearance, units and language","keywords":"settings theme dark light units metric imperial speed language colors charts","steps":"Open Settings with the gear in the sidebar. Adjust appearance, language, display units and telemetry colors. Analytical tools store and query metric units; request converted duration/distance fields or ask the assistant to explain conversions."}),
    ];
    let words: Vec<_> = search
        .split_whitespace()
        .map(|s| s.to_lowercase())
        .filter(|s| s.len() > 2)
        .collect();
    let mut scored: Vec<_> = entries
        .into_iter()
        .map(|entry| {
            let text = entry.to_string().to_lowercase();
            let score = words.iter().filter(|w| text.contains(w.as_str())).count();
            (score, entry)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let matches: Vec<_> = scored
        .into_iter()
        .filter(|(score, _)| words.is_empty() || *score > 0)
        .take(6)
        .map(|(_, v)| v)
        .collect();
    json!({"features":matches,"guidance_only":true,"response_rules":{"format":"Plain-language numbered app steps from the returned feature steps. No tool schemas or code snippets.","do_not_invent":"There is no JSON/tool-call dialog for users. The listed backend tools are assistant-internal, not user controls. Do not tell users to paste JSON or claim Excel exports. Distinguish native flight exports from bounded chat result CSV/report HTML exports.","coverage":"If this search does not cover another part of the user's question, search the feature catalog again with those terms."},"note":"Names may be translated in the selected app language. The assistant cannot interact with app controls."})
}
