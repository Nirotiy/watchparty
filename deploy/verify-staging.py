"""Probe staged TLS and authentication without exposing credentials or mutating catalogs."""
import base64
import http.client
import json
import pathlib
import socket
import sqlite3
import ssl
import sys

root = pathlib.Path(sys.argv[1]).resolve()
operator = json.loads((root / "vps-config-20261001/operator-input.json").read_text())
ca = root / "caddy-data/caddy/pki/authorities/local/root.crt"
context = ssl.create_default_context(cafile=str(ca))
results = {}


class LoopbackTLS(http.client.HTTPSConnection):
    def connect(self):
        connection = socket.create_connection(("127.0.0.1", self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(connection, server_hostname=self.host)
        except BaseException:
            connection.close()
            raise


def request(port, path, method="GET", identity=None, body=None, origin=None, tls=False):
    connection = LoopbackTLS("39.108.227.53", port, context=context, timeout=20) if tls else http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    headers = {}
    if identity:
        value = operator[identity + "Username"] + ":" + operator[identity + "Password"]
        headers["Authorization"] = "Basic " + base64.b64encode(value.encode()).decode()
    if origin:
        headers["Origin"] = origin
    if body is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(body)
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        payload = response.read()
        for key in ("sitePassword", "approvalPassword", "approvalSecret"):
            if operator[key].encode() in payload:
                raise RuntimeError("A response exposed a secret")
        return response.status, payload
    finally:
        connection.close()


def check(name, condition):
    results[name] = bool(condition)


for name, host, trust in [("unknownCaRejected", "39.108.227.53", ssl.create_default_context()), ("wrongIpRejected", "127.0.0.1", context)]:
    try:
        connection = LoopbackTLS(host, 8443, context=trust, timeout=10)
        connection.connect()
        connection.close()
        check(name, False)
    except ssl.SSLCertVerificationError:
        check(name, True)

baseline_status, baseline = request(18080, "/api/media/libraries")
for name, port, identity, tls in [("nextRestProxy", 13000, None, False), ("webCaddyProxy", 18000, "site", False), ("ipCaddyProxy", 8443, "site", True)]:
    status, payload = request(port, "/api/media/libraries", identity=identity, tls=tls)
    check(name, baseline_status == status == 200 and json.loads(baseline) == json.loads(payload))
for name, port, tls in [("webSiteAuth", 18000, False), ("ipSiteAuth", 8443, True)]:
    check(name, request(port, "/api/media/libraries", tls=tls)[0] == 401)
status, payload = request(8443, "/api/media/capabilities", identity="site", tls=True)
check("approvalModeSecret", status == 200 and json.loads(payload).get("catalogApproval") == "secret")
for name, port, identity, tls in [("backendCannotSelfApprove", 18080, None, False), ("publicCannotSelfApprove", 8443, "site", True)]:
    status, payload = request(port, "/api/admin/media-libraries/lib_anime/approval", "POST", identity, {}, tls=tls)
    check(name, status == 401 and json.loads(payload).get("code") == "CATALOG_APPROVAL_SECRET_REQUIRED")
path = "/api/catalog-approval/settings"
check("approvalRejectsSiteIdentity", request(18000, path, identity="site")[0] == 401)
check("approvalRejectsAnonymous", request(18000, path)[0] == 401)
status, payload = request(18000, path, identity="approval")
value = json.loads(payload)
check("approvalReadbackMasked", status == 200 and value.get("configured") is True and set(value) == {"configured", "mask"} and isinstance(value.get("mask"), str))
path = "/api/catalog-approval/libraries/deployment_missing_library/approval"
check("approvalRejectsWrongOrigin", request(18000, path, "POST", "approval", {}, "https://untrusted.invalid")[0] == 403)
check("authenticatedApprovalRoute", request(18000, path, "POST", "approval", {}, "https://watchparty.nirotiy.top")[0] == 404)
check("homepage", request(18000, "/", identity="site")[0] == 200)
check("openlistAdminNotProxied", request(18000, "/api/auth/login", "POST", "site", {})[0] == 404)
check("socketPolling", request(8443, "/socket.io/?EIO=4&transport=polling", identity="site", tls=True)[0] == 200)
with sqlite3.connect(f"file:{root / 'data/watchparty-catalog.sqlite'}?mode=ro", uri=True) as database:
    evidence = {"catalogItems": database.execute("SELECT count(*) FROM catalog_items").fetchone()[0], "approvals": database.execute("SELECT count(*) FROM catalog_approvals").fetchone()[0], "posters": database.execute("SELECT count(*) FROM poster_files").fetchone()[0], "integrity": database.execute("PRAGMA integrity_check").fetchone()[0]}
record = {"checks": results, "passed": all(results.values()), "baseline": evidence, "scope": "staged copy; structural approval, metadata and OpenList playback not evaluated"}
(root / "validation-staging.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record))
sys.exit(0 if record["passed"] else 1)
