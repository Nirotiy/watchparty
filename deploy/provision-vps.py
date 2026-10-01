"""Prepare operator-only files in a new deployment directory; never print values."""
import json
import os
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
configuration = root / "vps-config-20261001"
operator = json.loads((configuration / "operator-input.json").read_text())
image = "caddy@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b"
password_hash = subprocess.run(
    ["docker", "run", "--rm", "-i", image, "caddy", "hash-password"],
    input=operator["sitePassword"] + "\n", text=True, capture_output=True, check=True,
).stdout.strip()
for source, target in [(root / "compose.vps.yml", root / "compose.yml"), (root / "Caddyfile.vps", root / "Caddyfile")]:
    target.write_text(source.read_text(), encoding="utf-8")
environment = {
    "WATCHPARTY_PUBLIC_IP": "39.108.227.53",
    "WATCHPARTY_SITE_USERNAME": operator["siteUsername"],
    "WATCHPARTY_SITE_PASSWORD_HASH": password_hash,
    "WATCHPARTY_CADDY_IMAGE": image,
}
environment_file = root / ".env"
if environment_file.exists():
    raise RuntimeError("Refusing to overwrite deployment environment")
environment_file.write_text("".join(key + "='" + value + "'\n" for key, value in environment.items()), encoding="utf-8")
os.chmod(environment_file, 0o600)
for name in ["backend.env", "approval"]:
    (configuration / name).rename(root / name)
(root / "vps-snapshot-20261001" / "data").rename(root / "data")
result = subprocess.run(
    ["docker", "run", "--rm", "--network", "host", "-v", str(root / "Caddyfile") + ":/etc/caddy/Caddyfile:ro", "-e", "WATCHPARTY_PUBLIC_IP", "-e", "WATCHPARTY_SITE_USERNAME", "-e", "WATCHPARTY_SITE_PASSWORD_HASH", image, "caddy", "validate", "--config", "/etc/caddy/Caddyfile"],
    env={**os.environ, **environment}, text=True, capture_output=True,
)
if result.returncode:
    # Caddy errors could quote config values, so keep raw diagnostics private.
    diagnostic = root / "caddy-validation-private.log"
    diagnostic.write_text(result.stdout + result.stderr)
    os.chmod(diagnostic, 0o600)
    raise RuntimeError("Caddy validation failed; inspect private diagnostic with redaction")
print("Caddy configuration validated; credentials were not logged")
