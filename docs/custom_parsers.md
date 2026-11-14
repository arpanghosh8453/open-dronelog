# Custom Parsers Guideline

Open-DroneLog supports plugins for parsing custom and proprietary drone log formats. Instead of writing Rust code and recompiling the application, you can write standalone scripts or executables (in Python, Bash, Node.js, etc. on the desktop app; in Docker, Python or self-contained executables, see [Docker deployment](#5-docker-deployment)) that convert your logs into the standard **Open DroneLog CSV** format. 

Open-DroneLog will execute your scripts automatically during the import process when it detects a matching file extension.

The same custom parser engine is used by:
- Desktop (Tauri)
- Web/Docker API mode

---

## 1. How the Plugin System Works

1. **Configuration (`parsers.json`)**: You define which file extensions should be handled by your custom scripts.
2. **Startup discovery + logging**: At startup, Open-DroneLog reads `parsers.json`, logs each discovered mapping, and logs the final allowed extension list.
3. **Execution**: During import, Open-DroneLog first tries built-in parsers. If they fail (or are incompatible), it checks custom mappings by file extension and runs the mapped command.
4. **Arguments**: The app replaces `$INPUT` and `$OUTPUT` in `args` before spawning your command.
5. **Ingestion**: Your script must write a valid Open DroneLog CSV to `$OUTPUT`. If the process exits `0` and the output file exists, Open-DroneLog imports it.

### Extension matching notes
- Mapping keys are case-insensitive and normalized.
- Both `"ulg"` and `".ulg"` are accepted as mapping keys.
- Built-in defaults are: `txt`, `csv`.
- Mapped custom extensions are added dynamically to the allowed list used by browse, drag/drop, and sync scanning.

---

## 2. Configuration (`parsers.json`)

Create a `parsers.json` file in the location used by your runtime mode.

**For the Desktop App:**
- **Linux**: `~/.local/share/com.drone-logbook/parsers.json`
- **Windows**: `C:\Users\<User>\AppData\Roaming\com.drone-logbook\parsers.json`
- **macOS**: `~/Library/Application Support/com.drone-logbook/parsers.json`

**For the Web/Docker App:**
- **Linux/Docker**: place it at the fixed path `/app/plugins/parsers.json` inside the container.
- Example single-file bind mount: `./plugins/parsers.json:/app/plugins/parsers.json:ro`

### Example `parsers.json`

```json
{
  "mappings": {
    "mylog": {
      "command": "python3",
      "args": ["/absolute/path/to/my_parser.py", "$INPUT", "$OUTPUT"]
    },
    "binlog": {
      "command": "/absolute/path/to/binlog-parser-executable",
      "args": ["--input", "$INPUT", "--export-csv", "$OUTPUT"]
    }
  }
}
```

* `$INPUT`: Will be replaced by Open-DroneLog with the absolute path of the uploaded file.
* `$OUTPUT`: Will be replaced by Open-DroneLog with the absolute path where your script must save the CSV for the import.

If your mapping uses `"ulg"`, files like `flight_001.ulg` are allowed automatically without editing frontend source code.

---

## 3. The Target CSV Format

Your script **must** output a CSV file that matches the Open DroneLog CSV specification. 

### Minimal Required Columns
To successfully trace a flight path and calculate statistics, your CSV must contain a header row with at least these columns (case-insensitive):
- `time_s`: Timestamp relative to the start of the flight, in decimal seconds (e.g., `1.2`, `1.4`).
- `lat`: Latitude in decimal degrees.
- `lng`: Longitude in decimal degrees.
- `alt_m` (or `alt_ft`): Altitude relative to the takeoff point.
- `distance_to_home_m` (or `distance_to_home_ft`): Straight-line distance between the drone and the recorded home point.

*If an exact value is unknown for a particular row, leave the field empty (e.g. `1.2,45.0,9.0,,10.5`).*

### Extended Columns (Optional)
Including these columns enables the matching charts and telemetry panels in the dashboard:
- **Velocity**: `speed_ms` (or `speed_mph`), `velocity_x_ms`, `velocity_y_ms`, `velocity_z_ms`
- **Battery**: `battery_percent`, `battery_voltage_v`, `battery_temp_c` (or `battery_temp_f`), `cell_voltages` (JSON array: `[4.1, 4.1, 4.1]`)
- **Orientation**: `pitch_deg`, `roll_deg`, `yaw_deg`
- **Height (Ultrasonic/VPS)**: `vps_height_m` (or `vps_height_ft`)
- **Action/State**: `is_photo` (`1` or `0`), `is_video` (`1` or `0`), `flight_mode`
- **RC Inputs**: `rc_aileron`, `rc_elevator`, `rc_throttle`, `rc_rudder`
- **Signal**: `satellites`, `rc_signal`

### Metadata Column (Highly Recommended)
You can provide flight-level metadata by embedding a JSON string inside the `Metadata` column of your CSV. This string only needs to be present in the **first data row**, and can be left blank for subsequent rows. Open-DroneLog extracts details like the drone model, pilot notes, serial numbers, and tags from this object.

Example JSON structure:
```json
{
  "drone_model": "Custom Quadcopter",
  "drone_serial": "SN-12345",
  "battery_serial": "BAT-999",
  "start_time": "2026-03-14T15:30:00Z",
  "notes": "Test flight over the field",
  "tags": [
    {"tag": "Survey", "tag_type": "manual"},
    {"tag": "High Wind", "tag_type": "auto"}
  ]
}
```
*Note: Ensure the JSON string is properly escaped if written manually inside the CSV.*

### App Messages Column (Optional)
Similar to metadata, you can provide warnings or tips (like "Wind Warning") by adding a `Messages` column. Put a JSON array in the first data row:
```json
[
  { "timestamp_ms": 15000, "type": "warning", "message": "High Wind Velocity" },
  { "timestamp_ms": 120000, "type": "tip", "message": "Return to Home Triggered" }
]
```

---

## 4. Script Execution Guidelines

1. **Exit Codes**: Open-DroneLog only ingests the `$OUTPUT` CSV if your script exits with status code `0`. If your parser encounters an error or an invalid file, it should exit with a non-zero status code (for example `1`) and print details to `stderr`.
2. **Output path**: Always write the final CSV exactly to `$OUTPUT` (not to an adjacent file). Open-DroneLog validates that this file exists after your process exits.
3. **Performance**: Avoid heavy computations. If parsing takes too long, import can fail.
4. **Environment**: If running Open-DroneLog via Docker, your scripts run inside the container. 
   - **Python 3 is bundled** in the Docker image. You can invoke it directly in your `parsers.json` `command` and mount your scripts via volumes. Node.js, Bash and other interpreters are **not** included.
   - For other languages, write a self-contained compiled binary (like Go or Rust) statically linked for Linux, or build a custom image extending the base Dockerfile.

### Command portability tip
- On Windows desktop, prefer `python` (or an absolute path to `python.exe`) if `python3` is not available on `PATH`.
- On Linux/Docker, `python3` is available (it resolves to the parser virtualenv).

### Example Python Parser (`my_parser.py`)

```python
import sys
import csv
import json

def parse_my_format(input_path, output_path):
    # Dummy logic to read custom format
    # ...

    with open(output_path, 'w', newline='') as f:
        writer = csv.writer(f)
        
        # Write Open DroneLog headers
        writer.writerow(['time_s', 'lat', 'lng', 'alt_m', 'distance_to_home_m', 'battery_percent', 'Metadata'])
        
        # Write first row with Metadata JSON
        meta_json = json.dumps({
            "drone_model": "Custom FPV",
            "start_time": "2026-03-14T10:00:00Z"
        })
        writer.writerow(['0.1', '37.7749', '-122.4194', '0.0', '0.0', '100', meta_json])
        
        # Write subsequent rows
        writer.writerow(['1.1', '37.7750', '-122.4195', '5.2', '10.5', '99', ''])
        writer.writerow(['2.1', '37.7751', '-122.4196', '10.1', '21.0', '98', ''])

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(1)
        
    in_file = sys.argv[1]
    out_file = sys.argv[2]
    
    try:
        parse_my_format(in_file, out_file)
        sys.exit(0)
    except Exception as e:
        print(f"Failed to parse log: {e}", file=sys.stderr)
        sys.exit(1)
```

---

## 5. Docker Deployment

> [!IMPORTANT]
> The Docker image is a minimal distroless image: it has **no shell, Bash, Node.js, package manager or common CLI tools**, and the container runs as a non-root user (UID `65532`) with a read-only root filesystem. In Docker, custom parsers can therefore be:
> - **Python 3.13 scripts** using the standard library plus the packages from `requirements.txt` (see below), or
> - **self-contained executables** (statically linked, or linked only against glibc/libstdc++), e.g. compiled Go/Rust/C++ binaries.
>
> Shell scripts (`bash`, `sh`) and Node.js parsers are **not supported** in the Docker image. Parser scripts must not write next to themselves: `/app/plugins` should be mounted read-only, and temporary files belong in `/tmp`.

When deploying Open-DroneLog in Docker, map a plugins folder in your `docker-compose.yml`:

```yaml
services:
  open-dronelog:
    image: arpanghosh8453/open-dronelog:latest
    volumes:
      - ./data:/data/drone-logbook  # must be writable by UID/GID 65532
      - ./plugins:/app/plugins:ro   # Mount your custom scripts here (must be readable/executable by UID 65532)
```

And configure your `parsers.json` (placed at `/app/plugins/parsers.json` in Docker/web mode) to invoke your script using Python or a standalone binary (executables must have the execute bit set and be readable by UID `65532`):
```json
{
  "mappings": {
    "custom": {
      "command": "/app/plugins/my-binary-parser-linux-amd64",
      "args": ["$INPUT", "$OUTPUT"]
    }
  }
}
```

### Installing Python parser dependencies in Docker builds

If your custom parser script needs extra Python libraries (for example, `pandas`, `numpy`, `pyproj`), add them to the repository `requirements.txt` file and rebuild the image.

1. Edit `requirements.txt` and add your packages.
2. Rebuild the Docker image (for local source builds):
  - `cd open-dronelog && docker compose -f docker-compose-build.yml build --no-cache open-dronelog`
3. Restart the container:
  - `docker compose -f docker-compose-build.yml up -d`

The Dockerfile installs this file during build inside a dedicated virtualenv (`/opt/parser-venv`) and prepends that venv to `PATH`, so parser commands like `python3` automatically use those installed packages. `pip` is not available at runtime, so all packages must be listed in `requirements.txt` before building.

For Docker/web builds, prefer using the explicit venv interpreter path in `parsers.json`:

```json
{
  "mappings": {
    "mylog": {
      "command": "/opt/parser-venv/bin/python",
      "args": ["/app/plugins/my_parser.py", "$INPUT", "$OUTPUT"]
    }
  }
}
```

Important:
- Use `/opt/parser-venv/bin/python` as the interpreter (not `/opt/parser-venv/<script>.py`).
- Keep your parser script path pointing to where it is mounted or copied (for example `/app/plugins/my_parser.py`). This is docker's internal path, so make sure to bind-mount this properly to your external location on host. 

Notes:
- This applies to images you build from source (`docker-compose-build.yml`).
- If you use the prebuilt image (`docker-compose.yml`), you must build your own derived image to add extra Python packages.

---

## 6. Troubleshooting

If a custom parser is not being used, check logs in this order:

1. **Startup registration logs**
- `Custom parser mappings discovered: N`
- `Registered custom parser: .ulg -> command='...' args=[...]`
- `Allowed import extensions at startup: [...]`

2. **Import fallback logs**
- `Built-in parser failed or incompatible ... Trying custom plugins...`
- `Custom plugin lookup for extension: '.ulg'`
- `Found custom parser mapping for '.ulg' ...` or `No custom parser mapping matched ...`

3. **Plugin execution logs**
- `Executing custom parser plugin subprocess: ...`
- `Custom parser output temp path: ...`
- `Custom parser produced output CSV: ... (size: ... bytes)`

If you see process success but no import, common causes are:
- Script wrote CSV to the wrong path (not `$OUTPUT`).
- CSV does not match Open DroneLog format.
- Command is invalid in current runtime (`python3` not found, wrong executable path, missing script file).

For web mode, extension allowing and parser mapping are also dynamic at startup and exposed via API, so the web file picker/drop and sync flows follow the same extension map from `parsers.json`.
