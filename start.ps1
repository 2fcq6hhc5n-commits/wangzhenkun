$env:PORT = if ($env:PORT) { $env:PORT } else { "8765" }
$env:REFRESH_INTERVAL_MINUTES = if ($env:REFRESH_INTERVAL_MINUTES) { $env:REFRESH_INTERVAL_MINUTES } else { "10" }
python server.py
