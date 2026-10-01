use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};
use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair, KeyUsagePurpose};
use watchparty_desktop::{config::OriginTrustStore, http::DesktopHttpTransport};

struct TlsFixture {
    origin: String,
    root: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl TlsFixture {
    fn new(san: &str, expired: bool, response: &str) -> Self {
        let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca.distinguished_name.push(rcgen::DnType::CommonName, "WatchParty test root");
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let ca_key = KeyPair::generate().unwrap();
        let ca = ca.self_signed(&ca_key).unwrap();
        let leaf_key = KeyPair::generate().unwrap();
        let mut leaf = CertificateParams::new(vec![san.into()]).unwrap();
        if expired {
            leaf.not_before = rcgen::date_time_ymd(2000, 1, 1);
            leaf.not_after = rcgen::date_time_ymd(2001, 1, 1);
        }
        let leaf = leaf.signed_by(&leaf_key, &ca, &ca_key).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions().unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![leaf.der().clone()], rustls::pki_types::PrivatePkcs8KeyDer::from(leaf_key.serialize_der()).into()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("https://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let worker_stop = stop.clone();
        let worker_requests = requests.clone();
        let response = response.to_owned();
        let config = Arc::new(config);
        let worker = thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                let Ok((socket, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let connection = rustls::ServerConnection::new(config.clone()).unwrap();
                let mut stream = rustls::StreamOwned::new(connection, socket);
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let count = match stream.read(&mut buffer) {
                        Ok(count) => count,
                        Err(_) => break,
                    };
                    if count == 0 { break; }
                    request.extend_from_slice(&buffer[..count]);
                    if request.windows(4).any(|part| part == b"\r\n\r\n") { break; }
                }
                if request.is_empty() { continue; }
                worker_requests.lock().unwrap().push(String::from_utf8_lossy(&request).into_owned());
                let _ = stream.write_all(response.as_bytes());
                stream.conn.send_close_notify();
                let _ = stream.flush();
            }
        });
        Self { origin, root: ca.pem(), requests, stop, worker: Some(worker) }
    }
}

impl Drop for TlsFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn store() -> (std::path::PathBuf, OriginTrustStore) {
    let directory = std::env::temp_dir().join(format!("watchparty-tls-test-{}", uuid::Uuid::new_v4()));
    let store = OriginTrustStore::new(directory.clone());
    (directory, store)
}

const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";

#[test]
fn private_ca_is_required_and_approval_uses_the_same_trust() {
    let server = TlsFixture::new("127.0.0.1", false, OK);
    let (directory, store) = store();
    let untrusted = DesktopHttpTransport::new(&server.origin).unwrap();
    assert!(untrusted.media_request("GET", "/api/media/libraries", None, None).is_err());
    store.import(&server.origin, &server.root).unwrap();
    let trusted = DesktopHttpTransport::with_site_basic_auth(&server.origin, "test-user", "test-password")
        .unwrap().with_origin_trust(&store).unwrap();
    assert_eq!(trusted.media_request("GET", "/api/media/libraries", None, None).unwrap().0, 200);
    assert_eq!(trusted.media_request_with_approval("POST", "/api/admin/media-libraries/lib_test/approval", None, None, Some("test-only-approval")).unwrap().0, 200);
    let requests = server.requests.lock().unwrap();
    assert!(!requests[0].to_ascii_lowercase().contains("x-watchparty-approval:"));
    assert!(requests[1].to_ascii_lowercase().contains("x-watchparty-approval: test-only-approval"));
    drop(requests);
    store.delete(&server.origin).unwrap();
    assert!(DesktopHttpTransport::new(&server.origin).unwrap().with_origin_trust(&store).unwrap()
        .media_request("GET", "/api/media/libraries", None, None).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn private_ca_does_not_bypass_ip_san_or_expiry() {
    for (san, expired) in [("192.0.2.1", false), ("127.0.0.1", true)] {
        let server = TlsFixture::new(san, expired, OK);
        let (directory, store) = store();
        store.import(&server.origin, &server.root).unwrap();
        let trusted = DesktopHttpTransport::new(&server.origin).unwrap().with_origin_trust(&store).unwrap();
        assert!(trusted.media_request("GET", "/api/media/libraries", None, None).is_err());
        assert!(server.requests.lock().unwrap().is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn private_ca_and_redirects_are_origin_scoped() {
    let other = TlsFixture::new("127.0.0.1", false, OK);
    let response = format!("HTTP/1.1 302 Found\r\nLocation: {}/api/media/libraries\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", other.origin);
    let server = TlsFixture::new("127.0.0.1", false, &response);
    let (directory, store) = store();
    store.import(&server.origin, &server.root).unwrap();
    assert!(DesktopHttpTransport::new(&other.origin).unwrap().with_origin_trust(&store).unwrap()
        .media_request("GET", "/api/media/libraries", None, None).is_err());
    let trusted = DesktopHttpTransport::new(&server.origin).unwrap().with_origin_trust(&store).unwrap();
    assert_eq!(trusted.media_request("GET", "/api/media/libraries", None, None).unwrap().0, 302);
    assert_eq!(trusted.media_request_with_approval("POST", "/api/admin/media-libraries/lib_test/approval", None, None, Some("test-only-approval")).unwrap().0, 302);
    assert!(other.requests.lock().unwrap().is_empty());
    std::fs::remove_dir_all(directory).unwrap();
}
