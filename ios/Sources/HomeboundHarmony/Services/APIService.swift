import Foundation

// Thin URLSession wrapper that mirrors the fetch API from src/lib/api.ts.
// Cookies are managed automatically by URLSession.shared via
// HTTPCookieStorage.shared — the __Host-session cookie set by the server
// is persisted and sent on every subsequent request.

enum APIError: LocalizedError {
    case invalidURL
    case httpError(Int, String?)
    case decodingError(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid server URL. Check Settings."
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
        let urlString = baseURL + path
        guard let url = URL(string: urlString) else {
            throw APIError.invalidURL
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(body)
        }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }

        let (data, response) = try await session.data(for: req)

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
}
