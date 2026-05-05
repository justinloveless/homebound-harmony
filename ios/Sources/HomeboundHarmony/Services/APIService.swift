import Foundation

// Thin URLSession wrapper that mirrors the fetch API from src/lib/api.ts.
// Cookies are managed automatically by URLSession.shared via
// HTTPCookieStorage.shared — the __Host-session cookie set by the server
// is persisted and sent on every subsequent request.

enum APIError: LocalizedError {
    /// Base URL missing, or the resolved URL is not absolute `http`/`https` (e.g. relative `/api/...`).
    case invalidURL
    /// TLS failed (often `https` on a port that only speaks plain HTTP, e.g. internal app port behind Coolify).
    case tlsHandshakeFailed
    case httpError(Int, String?)
    case decodingError(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Server URL not set or invalid. Enter a full base URL like https://your-server.example.com (no trailing slash)."
        case .tlsHandshakeFailed:
            return "TLS handshake failed. On Coolify (and similar), the public URL is usually https://your-domain with no “:3000”—that port is often plain HTTP while TLS is on 443. Try that, or use http:// only if nothing on that port speaks TLS."
        case .httpError(let status, let msg):
            return msg ?? "Request failed (\(status))"
        case .decodingError(let err):
            return "Response decode error: \(err.localizedDescription)"
        }
    }
}

final class APIService {

    private var baseURL: String {
        UserDefaults.standard.string(forKey: "apiBaseURL") ?? ""
    }

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieAcceptPolicy = .always
        cfg.httpShouldSetCookies = true
        cfg.httpCookieStorage = .shared
        return URLSession(configuration: cfg)
    }()

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Core request

    func request<T: Decodable>(
        method: String,
        path: String,
        body: (any Encodable)? = nil,
        headers: [String: String] = [:]
    ) async throws -> T {
        let url = try Self.makeAbsoluteURL(baseURL: baseURL, path: path)

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(body)
        }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw Self.mapTransportError(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.httpError(0, nil)
        }

        if !(200...299).contains(http.statusCode) {
            let msg = (try? decoder.decode([String: String].self, from: data))?["error"]
            throw APIError.httpError(http.statusCode, msg)
        }

        // Bodyless success (e.g., 204 logout)
        if data.isEmpty, T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    // MARK: - Convenience

    func get<T: Decodable>(path: String, headers: [String: String] = [:]) async throws -> T {
        try await request(method: "GET", path: path, headers: headers)
    }

    func post<T: Decodable>(path: String, body: (any Encodable)? = nil) async throws -> T {
        try await request(method: "POST", path: path, body: body)
    }

    func put<T: Decodable>(
        path: String,
        body: (any Encodable)? = nil,
        headers: [String: String] = [:]
    ) async throws -> T {
        try await request(method: "PUT", path: path, body: body, headers: headers)
    }

    func delete<T: Decodable>(path: String) async throws -> T {
        try await request(method: "DELETE", path: path)
    }

    /// Ensures `URLSession` gets an absolute `http`/`https` URL; empty base yields a clear error instead of NSURLError -1002.
    private static func makeAbsoluteURL(baseURL: String, path: String) throws -> URL {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw APIError.invalidURL }

        let urlString = trimmed + path
        guard let url = URL(string: urlString) else { throw APIError.invalidURL }

        let scheme = url.scheme?.lowercased()
        guard scheme == "http" || scheme == "https", url.host != nil else {
            throw APIError.invalidURL
        }
        return url
    }

    private static func mapTransportError(_ error: Error) -> Error {
        if let urlError = error as? URLError, urlError.code == .secureConnectionFailed {
            return APIError.tlsHandshakeFailed
        }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorSecureConnectionFailed {
            return APIError.tlsHandshakeFailed
        }
        return error
    }
}
