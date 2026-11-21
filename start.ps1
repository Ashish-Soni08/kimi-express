# Starts the Kimi Express dashboard on Windows.
# Needs: OpenClaw gateway running with the kimi-express-tools plugin (see README).
# If your gateway uses token auth, set OPENCLAW_GATEWAY_TOKEN in this window first:
#   $env:OPENCLAW_GATEWAY_TOKEN = "<your gateway token>"
Set-Location $PSScriptRoot
Start-Process "http://127.0.0.1:5177"
node server/server.mjs
