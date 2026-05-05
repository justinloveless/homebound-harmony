// swift-tools-version: 5.9
// Thin Swift wrapper around the reference Argon2 implementation (pinned revision).

import PackageDescription

let package = Package(
    name: "RouteCareArgon2",
    platforms: [
        .iOS(.v13),
        .macOS(.v11),
    ],
    products: [
        .library(name: "RouteCareArgon2", targets: ["RouteCareArgon2"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/P-H-C/phc-winner-argon2.git",
            revision: "f57e61e19229e23c4445b85494dbf7c07de721cb"
        ),
    ],
    targets: [
        .target(
            name: "RouteCareArgon2",
            dependencies: [
                .product(name: "argon2", package: "phc-winner-argon2"),
            ],
            path: "Sources"
        ),
    ]
)
