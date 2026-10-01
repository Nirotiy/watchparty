"""Verify immutable image access with an empty Docker credential directory."""
import json
import subprocess
import tempfile

references = [
    "ghcr.io/nirotiy/watchparty-backend@sha256:7a56597bc5d0fb9a12ccf03df7048892d8bbc3c18bdebb5fbd37f9c0b18f9b1d",
    "ghcr.io/nirotiy/watchparty-frontend@sha256:6820ee398fc7f27792d9923a9bb6d92fbcd7806d529585ef0e9f023a9be45409",
]
with tempfile.TemporaryDirectory(prefix="watchparty-anonymous-") as config:
    for reference in references:
        subprocess.run(["docker", "--config", config, "pull", reference], check=True)
        image = json.loads(subprocess.check_output(["docker", "image", "inspect", reference]))[0]
        revision = image["Config"]["Labels"]["org.opencontainers.image.revision"]
        if revision != "241c55993bdee9d2a28684bd2b8e1255eedf8bbd":
            raise RuntimeError("Image revision does not match verified source")
        print(json.dumps({"image": reference, "revision": revision, "anonymousPull": True}))
